//! Docker image listing.
//!
//! We shell out to the `docker` CLI rather than talk to the daemon
//! socket — same coverage with no Rust dep, and the surface is just
//! `docker version` (detect) + `docker image ls` (list).

use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DockerImage {
    /// `<repository>:<tag>` joined for display, or `<none>:<none>` for
    /// dangling images.
    pub label: String,
    pub repo: String,
    pub tag: String,
    /// Short image ID (12 chars), useful for `docker rmi <id>` later.
    pub id: String,
    pub size_bytes: u64,
    /// Docker's own human size string (`"1.23GB"`). Kept around because
    /// our `parse_human_bytes` is approximate.
    pub size_human: String,
    /// "5 minutes ago" / "3 weeks ago" — straight from Docker.
    pub created: String,
}

/// Is Docker installed and is the daemon reachable?
pub fn detect() -> bool {
    Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `docker image ls --format '{{json .}}'`, parsed into rows sorted
/// by size descending.
pub fn list_images() -> Result<Vec<DockerImage>, String> {
    let output = Command::new("docker")
        .args(["image", "ls", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("running docker: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker exited {}: {}", output.status, stderr.trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut images = Vec::new();
    for line in text.lines() {
        if line.is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return Err(format!("parsing docker output: {e}")),
        };
        let repo = v.get("Repository").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let tag  = v.get("Tag").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let id   = v.get("ID").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let size_human = v.get("Size").and_then(|s| s.as_str()).unwrap_or("0").to_string();
        let created    = v.get("CreatedSince").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let size_bytes = parse_human_bytes(&size_human);
        let label = if repo == "<none>" || repo.is_empty() {
            format!("<none>:{tag}")
        } else {
            format!("{repo}:{tag}")
        };
        images.push(DockerImage { label, repo, tag, id, size_bytes, size_human, created });
    }
    images.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(images)
}

/// Coarse "1.23GB" / "456MB" / "78kB" → bytes. Docker uses SI prefixes
/// (10^3-based) and the suffix capitalization is "GB" / "MB" / "kB" /
/// "B". Good enough for sort + display; we keep `size_human` around
/// for exact text.
fn parse_human_bytes(s: &str) -> u64 {
    let s = s.trim();
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, suffix) = s.split_at(split);
    let value: f64 = num.parse().unwrap_or(0.0);
    let mult = match suffix.to_uppercase().as_str() {
        "B"  => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        _    => 1.0,
    };
    (value * mult) as u64
}
