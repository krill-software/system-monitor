//! System Monitor — backend.
//!
//! A 2-second tick polls `sysinfo` and emits a `tick` event carrying a
//! `Snapshot`. The frontend re-renders the list in place. No request /
//! response — push only.

mod docker;
mod gpu;
mod groups;
mod storage;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, Signal, System};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use krill_desktop_core::updater::BuilderExt;

/// One application-group's rolled-up usage at a moment in time.
#[derive(Debug, Clone, Serialize)]
pub struct GroupRow {
    /// Stable key — used by the frontend to keep rows in place across ticks.
    pub id: String,
    /// Display label (cgroup app id title-cased, or executable basename).
    pub name: String,
    /// Pids of every process in this group at the moment of the snapshot.
    /// Used by `kill_group` so the kill targets exactly what the user saw.
    pub pids: Vec<u32>,
    /// Group CPU%, summed then normalized to "one core's worth"
    /// (so 100 means "one full core").
    pub cpu_per_core: f32,
    /// Group RSS in bytes.
    pub mem_bytes: u64,
    /// Group memory as a fraction of total system RAM (0..1).
    pub mem_frac: f32,
}

/// A single tick's payload: a system overview + the list of groups.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    /// System CPU% (averaged across cores, 0..100).
    pub cpu_total: f32,
    /// System memory as a fraction of total RAM (0..1).
    pub mem_frac: f32,
    /// Total RAM bytes — included so the UI can render absolute mem.
    pub mem_total: u64,
    /// Core count — included for the UI's CPU-per-core readouts.
    pub cores: usize,
    /// Whether this is the first sample (CPU% needs two ticks to be valid;
    /// the UI shows "—" for CPU on the very first emission).
    pub first_sample: bool,
    /// Application groups, unsorted — UI sorts by status.
    pub groups: Vec<GroupRow>,
}

struct AppCtx {
    sys: Mutex<System>,
    /// True until the second tick lands. CPU% from `sysinfo` is the
    /// delta between two refresh calls, so the first reading is junk.
    first: std::sync::atomic::AtomicBool,
}

impl AppCtx {
    fn new() -> Self {
        Self {
            sys: Mutex::new(System::new_with_specifics(
                RefreshKind::new()
                    .with_cpu(sysinfo::CpuRefreshKind::everything())
                    .with_memory(sysinfo::MemoryRefreshKind::everything())
                    .with_processes(ProcessRefreshKind::everything()),
            )),
            first: std::sync::atomic::AtomicBool::new(true),
        }
    }
}

async fn tick(ctx: &AppCtx) -> Snapshot {
    let mut sys = ctx.sys.lock().await;
    sys.refresh_cpu_all();
    sys.refresh_memory();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let cores = sys.cpus().len().max(1);
    let cpu_total = sys.global_cpu_usage();
    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();
    let mem_frac = if mem_total > 0 {
        (mem_used as f32) / (mem_total as f32)
    } else {
        0.0
    };

    // Map each process to a group id + display name.
    let mut by_group: std::collections::HashMap<String, (String, GroupRow)> =
        std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        let (id, name) = groups::classify(*pid, proc);
        let entry = by_group
            .entry(id.clone())
            .or_insert_with(|| (name.clone(), GroupRow {
                id: id.clone(),
                name,
                pids: Vec::new(),
                cpu_per_core: 0.0,
                mem_bytes: 0,
                mem_frac: 0.0,
            }));
        entry.1.pids.push(pid.as_u32());
        entry.1.cpu_per_core += proc.cpu_usage();
        entry.1.mem_bytes += proc.memory();
    }

    // Normalize CPU% so 100 = "one full core", and compute mem fraction.
    let mut groups: Vec<GroupRow> = by_group
        .into_values()
        .map(|(_n, mut g)| {
            g.cpu_per_core /= cores as f32;
            g.mem_frac = if mem_total > 0 {
                (g.mem_bytes as f32) / (mem_total as f32)
            } else {
                0.0
            };
            g
        })
        .collect();

    // Drop the tiniest groups — anything below the OK threshold on BOTH
    // metrics is noise (kernel helpers, idle daemons). Keeps the row count
    // manageable without virtualization.
    groups.retain(|g| g.cpu_per_core >= 1.0 || g.mem_frac >= 0.005);

    // Stable pid order so the frontend can dedupe / display "N processes"
    // identically across ticks.
    for g in &mut groups {
        g.pids.sort_unstable();
    }

    let first_sample = ctx
        .first
        .swap(false, std::sync::atomic::Ordering::Relaxed);

    Snapshot {
        cpu_total,
        mem_frac,
        mem_total,
        cores,
        first_sample,
        groups,
    }
}

/// Result of attempting to kill a group of processes.
#[derive(Debug, Clone, Serialize)]
pub struct KillReport {
    /// How many pids we successfully signalled.
    pub killed: usize,
    /// Pids we could not signal — usually because they belonged to
    /// another user (root daemons, etc.) and we don't have permission.
    pub failed: Vec<u32>,
}

/// Send SIGTERM to every pid in `pids`. Refreshes the process list once
/// first so we don't try to signal pids that have already exited.
/// SIGTERM, not SIGKILL — gentle quit, lets the target clean up. A
/// future "force kill" escalation can layer on top.
#[tauri::command]
async fn kill_group(
    pids: Vec<u32>,
    state: State<'_, Arc<AppCtx>>,
) -> Result<KillReport, String> {
    let mut sys = state.sys.lock().await;
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut killed = 0usize;
    let mut failed = Vec::new();
    for pid in pids {
        let p = match sys.process(Pid::from_u32(pid)) {
            Some(p) => p,
            None => continue, // already exited; not a failure
        };
        match p.kill_with(Signal::Term) {
            Some(true) => killed += 1,
            Some(false) | None => failed.push(pid),
        }
    }
    Ok(KillReport { killed, failed })
}

/// Scan the home filesystem: disk total/used/free + top-level
/// category sizes. Runs on a blocking thread (walks can be slow).
#[tauri::command]
async fn scan_storage() -> Result<storage::StorageSnapshot, String> {
    tokio::task::spawn_blocking(storage::scan_storage_impl)
        .await
        .map_err(|e| format!("scan_storage panic: {e}"))
}

/// Drill into one directory — sums each immediate child's size.
#[tauri::command]
async fn scan_category(path: String) -> Result<Vec<storage::DirRow>, String> {
    tokio::task::spawn_blocking(move || {
        storage::scan_category_impl(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| format!("scan_category panic: {e}"))
}

/// Hand a path off to the desktop's preferred handler (`xdg-open`).
/// Used by the per-row "Open" button on storage rows.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open failed: {e}"))
}

/// One-shot environment probe — what features the app can offer on
/// this machine. Called once at frontend boot; the result decides
/// which sidebar tabs render active vs. muted.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Capabilities {
    pub docker: bool,
    pub gpu: gpu::GpuAvailability,
}

#[tauri::command]
fn capabilities() -> Capabilities {
    Capabilities {
        docker: docker::detect(),
        gpu: gpu::detect(),
    }
}

#[tauri::command]
async fn list_docker_images() -> Result<Vec<docker::DockerImage>, String> {
    tokio::task::spawn_blocking(docker::list_images)
        .await
        .map_err(|e| format!("list_docker_images panic: {e}"))?
}

#[tauri::command]
async fn nvidia_gpu_stats() -> Result<gpu::GpuStats, String> {
    tokio::task::spawn_blocking(gpu::nvidia_stats)
        .await
        .map_err(|e| format!("nvidia_gpu_stats panic: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ctx = Arc::new(AppCtx::new());

    tauri::Builder::default()
        .manage(ctx.clone())
        .with_updater()
        .invoke_handler(tauri::generate_handler![
            kill_group,
            scan_storage,
            scan_category,
            open_path,
            capabilities,
            list_docker_images,
            nvidia_gpu_stats,
        ])
        .setup(move |app| {
            let handle: AppHandle = app.handle().clone();
            let ctx = app.state::<Arc<AppCtx>>().inner().clone();
            // Background ticker — emits a Snapshot every TICK_MS.
            tauri::async_runtime::spawn(async move {
                const TICK_MS: u64 = 2000;
                loop {
                    let snap = tick(&ctx).await;
                    let _ = handle.emit("tick", &snap);
                    tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
