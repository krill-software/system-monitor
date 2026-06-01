//! Storage scanner — walks key user dirs and reports rolled-up sizes.
//!
//! Two layers:
//!   `scan_storage()`       — disk total/used/free + top-level categories
//!   `scan_category(path)`  — immediate children of any directory
//!
//! Walks are bounded to one filesystem (`same_file_system`) so they
//! don't follow into bind mounts / overlayfs / other devices.
//! Permission errors are skipped silently. Symlinks are not followed.
//!
//! No global cache here — caching is the frontend's job (per-session,
//! re-runs on Refresh).

use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::Disks;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
pub struct StorageSnapshot {
    /// Mount point covering the user's home (e.g. "/" or "/home").
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub categories: Vec<DirRow>,
}

/// One directory's rolled-up size. Same shape for top-level
/// categories and drill-down children.
#[derive(Debug, Clone, Serialize)]
pub struct DirRow {
    /// Canonical absolute path — used as the id and as the argument
    /// to `scan_category` for drill-down.
    pub id: String,
    /// Display label. For categories: friendly name ("Pictures"). For
    /// drill-down children: the directory basename ("chromium").
    pub label: String,
    pub bytes: u64,
    /// `bytes / parent_total`, where parent_total is whichever scope
    /// is appropriate: the disk's total for categories, the parent
    /// directory's summed-children total for drill-down children.
    pub frac: f32,
    /// True if this entry is a directory (drillable). Files show as
    /// leaf rows with no chevron.
    pub is_dir: bool,
}

// ---- Helpers --------------------------------------------------------

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Sum of file sizes under `path`. Bounded to one filesystem. Skips
/// symlinks. Files we can't stat are skipped silently.
fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .same_file_system(true)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Top-level categories to surface — XDG-ish user dirs + the obvious
/// system eaters. Paths that don't exist are silently dropped.
fn categories() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        for (label, sub) in [
            ("Documents",   "Documents"),
            ("Pictures",    "Pictures"),
            ("Videos",      "Videos"),
            ("Music",       "Music"),
            ("Downloads",   "Downloads"),
            ("Desktop",     "Desktop"),
            ("Cache",       ".cache"),
            ("Local share", ".local/share"),
        ] {
            let p = h.join(sub);
            if p.exists() {
                out.push((label.to_string(), p));
            }
        }
    }
    for (label, path) in [
        ("System logs", "/var/log"),
        ("Temp",        "/tmp"),
    ] {
        let p = PathBuf::from(path);
        if p.exists() {
            out.push((label.to_string(), p));
        }
    }
    out
}

/// Pick the disk that covers the user's home (or root if no $HOME).
/// Most-specific mount point wins.
fn home_disk() -> (String, u64, u64) {
    let target = home().unwrap_or_else(|| PathBuf::from("/"));
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| target.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| (
            d.mount_point().display().to_string(),
            d.total_space(),
            d.available_space(),
        ))
        .unwrap_or_else(|| ("/".to_string(), 0, 0))
}

// ---- Public API -----------------------------------------------------

pub fn scan_storage_impl() -> StorageSnapshot {
    let (mount, total, free) = home_disk();
    let used = total.saturating_sub(free);

    // Walk each category in a worker thread; cap concurrency to 4 so
    // a busy disk doesn't get hammered. Top-level dirs are few enough
    // that a simple chunked-join keeps the code small.
    let cats = categories();
    let mut categories: Vec<DirRow> = Vec::with_capacity(cats.len());
    for chunk in cats.chunks(4) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|(label, path)| {
                let label = label.clone();
                let path = path.clone();
                std::thread::spawn(move || DirRow {
                    id: path.display().to_string(),
                    label,
                    bytes: dir_size(&path),
                    frac: 0.0,
                    is_dir: true,
                })
            })
            .collect();
        for h in handles {
            if let Ok(row) = h.join() {
                categories.push(row);
            }
        }
    }

    for c in &mut categories {
        c.frac = if total > 0 {
            (c.bytes as f32) / (total as f32)
        } else {
            0.0
        };
    }
    categories.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    StorageSnapshot { mount, total, used, free, categories }
}

/// Walk one level under `path` and return each child's rolled-up size.
/// `frac` is relative to the sum of the listed children — so a row at
/// 40% means "this child holds 40% of what's in here".
pub fn scan_category_impl(path: &Path) -> Vec<DirRow> {
    let mut rows = Vec::new();
    let read = match std::fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => return rows,
    };
    for entry in read.filter_map(Result::ok) {
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let bytes = if is_dir {
            dir_size(&p)
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        rows.push(DirRow {
            id: p.display().to_string(),
            label: entry.file_name().to_string_lossy().into_owned(),
            bytes,
            frac: 0.0,
            is_dir,
        });
    }
    let total: u64 = rows.iter().map(|r| r.bytes).sum();
    for r in &mut rows {
        r.frac = if total > 0 { (r.bytes as f32) / (total as f32) } else { 0.0 };
    }
    rows.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    rows
}
