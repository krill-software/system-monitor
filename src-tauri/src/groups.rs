//! Process → application-group resolution.
//!
//! Resolution chain, first match wins:
//!   1. systemd cgroup app scope     `app-<name>@<...>.scope`
//!   2. executable basename          (CLI tools, daemons)
//!   3. fallback                     `System`
//!
//! Each call returns `(group_id, display_name)`. The id is stable across
//! ticks; the name is a humanized version of it for display.

use std::fs;
use std::path::Path;

use sysinfo::{Pid, Process};

/// Classify a single process into a (group_id, display_name).
pub fn classify(pid: Pid, proc: &Process) -> (String, String) {
    if let Some(id) = cgroup_app_id(pid) {
        let name = humanize(&id);
        return (id, name);
    }

    // Fall back to the executable basename (the binary that's actually
    // running — not the cmdline[0] which can be a different argv0).
    if let Some(exe) = proc.exe().and_then(|p| p.file_name()) {
        let s = exe.to_string_lossy().into_owned();
        return (s.clone(), s);
    }

    // Last resort — kernel threads, processes whose /proc entries we
    // couldn't read.
    ("System".to_string(), "System".to_string())
}

/// Read `/proc/<pid>/cgroup` and look for a systemd `app-<id>@.scope`
/// or `app-<id>.scope` line. Returns the bare `<id>` (e.g. `firefox`).
fn cgroup_app_id(pid: Pid) -> Option<String> {
    let path = format!("/proc/{}/cgroup", pid.as_u32());
    let text = fs::read_to_string(Path::new(&path)).ok()?;
    for line in text.lines() {
        // Lines look like `0::/user.slice/.../app-firefox@1.scope`
        // or `0::/user.slice/.../app-firefox.scope`.
        let Some(idx) = line.find("app-") else { continue };
        let tail = &line[idx + 4..];
        // Cut at the first `@`, `.`, or `/` — that's the end of the app id.
        let end = tail
            .find(|c: char| c == '@' || c == '.' || c == '/')
            .unwrap_or(tail.len());
        if end == 0 {
            continue;
        }
        // systemd encodes dashes inside app ids as `\x2d` — undo that.
        let id = tail[..end].replace("\\x2d", "-");
        if id.is_empty() {
            continue;
        }
        return Some(id);
    }
    None
}

/// Title-case an app id for display. `gnome-shell` → `Gnome Shell`,
/// `firefox` → `Firefox`. Hyphens become spaces.
fn humanize(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    let mut cap = true;
    for ch in id.chars() {
        if ch == '-' || ch == '_' {
            out.push(' ');
            cap = true;
        } else if cap {
            out.extend(ch.to_uppercase());
            cap = false;
        } else {
            out.push(ch);
        }
    }
    out
}
