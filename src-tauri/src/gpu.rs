//! GPU detection + (best-effort) live stats.
//!
//! NVIDIA is the well-supported path: `nvidia-smi` ships with the
//! driver and exposes name / memory / utilization in a single CSV
//! query. We use that for live polling.
//!
//! AMD and Intel don't have a clean cross-distro CLI for usage. For
//! those we detect via `/sys/class/drm/cardN/device/vendor`, surface
//! the vendor name, and leave the live stats fields zeroed (the view
//! reads `live: false` and hides the bar instead of showing 0%).

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GpuAvailability {
    /// No GPU detected via either nvidia-smi or /sys/class/drm.
    None,
    /// A GPU is present. `live` indicates whether usage polling will
    /// return real numbers (currently true only for NVIDIA).
    Detected {
        vendor: String,
        name: String,
        live: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuStats {
    pub name: String,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub util_pct: u32,
}

pub fn detect() -> GpuAvailability {
    if let Some(name) = nvidia_name() {
        return GpuAvailability::Detected {
            vendor: "NVIDIA".to_string(),
            name,
            live: true,
        };
    }
    if let Some((vendor, name)) = detect_drm() {
        return GpuAvailability::Detected { vendor, name, live: false };
    }
    GpuAvailability::None
}

fn nvidia_name() -> Option<String> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let name = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Walk `/sys/class/drm` for the first real "cardN" (no `-` suffix —
/// those are connectors) and read its PCI vendor id.
fn detect_drm() -> Option<(String, String)> {
    let entries = std::fs::read_dir(Path::new("/sys/class/drm")).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("card") || name.contains('-') { continue; }
        let vendor_path = entry.path().join("device/vendor");
        let vendor = match std::fs::read_to_string(&vendor_path) {
            Ok(s) => s.trim().to_string(),
            Err(_) => continue,
        };
        let vendor_str = match vendor.as_str() {
            "0x10de" => "NVIDIA",
            "0x1002" => "AMD",
            "0x8086" => "Intel",
            _        => "GPU",
        };
        // We don't try to resolve a human name here — `lspci` would,
        // but it's another shell-out. "Intel GPU" / "AMD GPU" is good
        // enough for the muted state we render when live is false.
        return Some((vendor_str.to_string(), format!("{vendor_str} GPU")));
    }
    None
}

/// Live NVIDIA stats — name / mem-used / mem-total / util%.
pub fn nvidia_stats() -> Result<GpuStats, String> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|e| format!("running nvidia-smi: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("nvidia-smi exited {}: {}", output.status, stderr.trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = text.trim().split(',').map(|s| s.trim()).collect();
    if parts.len() < 4 {
        return Err(format!("nvidia-smi output unexpected: {}", text.trim()));
    }
    Ok(GpuStats {
        name: parts[0].to_string(),
        mem_used_mb: parts[1].parse().unwrap_or(0),
        mem_total_mb: parts[2].parse().unwrap_or(0),
        util_pct: parts[3].parse().unwrap_or(0),
    })
}
