# System Monitor — Spec (v1)

A glanceable system-load hint for Linux. Not a process manager — it answers one question: **"the computer feels slow; where do I look?"**

The whole UI is a short list of running applications, each with a traffic-light status. No 400-row process table, no graphs wall, no configuration. You open it, you see which app is hot, you close it.

## Goals

- Group raw processes into **applications** and show one status per app.
- A three-state traffic light — **OK / warn / high** — for CPU and for memory.
- A lightweight session history so the app can say *"this climbed since you opened it"* — answering "what did I do that started eating my memory?"
- Calm. The status dot is the vocabulary; everything else is muted text.

## Non-goals (v1)

- No full per-process table. (If you need `htop`, use `htop`.)
- No network panel.
- No historical graphs beyond a tiny inline sparkline.
- No refresh-rate setting, no column config, no theme. Baked defaults.
- No "favorites", no alerts, no notifications, no tray icon.
- No Windows / macOS builds.

## Storage view (v1)

A third sidebar entry alongside CPU and Memory. Answers "where is
my disk going?" with one click of drill-down.

**Scope of the scan**

Walks the user's home directory (XDG dirs + `.cache` + `.local/share`)
plus `/var/log` and `/tmp`. The walk is bounded to one filesystem
(`same_file_system`), doesn't follow symlinks, and skips entries we
can't `stat`. Anything outside `$HOME` and the two system dirs is
deferred — `/` scans need `sudo` and the big eats are almost always
in home anyway.

**System strip**

Disk total / used / free for the mount that covers `$HOME`. Status:
OK below 85% used, warn 85–95%, high above 95%.

**Categories list**

Top level shows: Documents, Pictures, Videos, Music, Downloads,
Desktop, Cache, Local share, System logs, Temp — sorted by size.
Each row carries:
- A folder/file icon.
- The label.
- An inline bar showing the row's fraction (vs. the disk total at
  the top level; vs. the parent's summed children when drilled in).
- The size in human bytes.
- A hover-revealed "Open in file manager" button (`xdg-open`).

**Drill-down**

Click any directory row → `scan_category(path)` runs on a blocking
thread, the list is replaced with the immediate children sorted by
size. A breadcrumb at the top of the list lets you jump back to any
ancestor. Files don't drill in (the chevron is omitted). A Refresh
button re-runs the top-level scan; drill-down state is cleared.

**Performance**

- Top-level scan parallelizes the categories four at a time on
  worker threads.
- Per-category drill-down is a single-level `read_dir` summed with
  `walkdir(same_file_system = true)` for each child.
- No caching beyond the in-process session — closing the app and
  reopening rescans.
- A scan on a typical laptop's home dir takes a few seconds; very
  large homes can take longer. UI shows "Scanning…" while busy.

## Docker view (v1)

Sidebar tab. Muted if Docker isn't installed or the daemon isn't
running (`docker version --format '{{.Server.Version}}'` is the
probe). When available, shows every image in `docker image ls`
sorted by size descending, with a filter input and a per-image bar
showing each one's share of the total stash. Rows display
`<repo>:<tag>`, the short image ID, "N ago" age, and the human size
straight from Docker. No `docker rmi` action in v1 — the suggested
shell command is the user's escalation path.

Refresh is manual (a button at the top). No background polling —
images don't move fast enough to warrant it.

## GPU view (v1)

Sidebar tab. Muted if no GPU is detected.

Detection is layered:
- **NVIDIA via `nvidia-smi`** is the fully-supported path. Polled
  every 2s for name / utilization% / VRAM used+total. Renders the
  same system-strip shape as CPU/Memory, plus a second VRAM strip
  below.
- **AMD / Intel via `/sys/class/drm/cardN/device/vendor`** is
  detection-only. The tab is reachable, the GPU name renders, but
  the strip shows a placeholder: live stats aren't available
  cross-vendor in v1.

The sidebar percentage tracks GPU utilization% (CPU thresholds —
<25 ok, <60 warn, >60 high).

## Quit a group (v1)

The application list carries a hover-revealed quit button on the
right of each row. Clicking it confirms (showing the group's process
count) then sends **SIGTERM** to every pid in that group. SIGTERM,
not SIGKILL — well-behaved apps clean up and exit; the system tool
chain (`kill -9`, `killall -9`) is still the right escalation for
processes that ignore Term.

The backend's `kill_group(pids)` returns a `KillReport { killed,
failed }` where `failed` lists pids we couldn't signal (usually
permission — root daemons, other users' processes). The UI doesn't
surface failures inline yet; check `console.warn` for now.

## Stack

- **Shell:** Tauri 2.
- **Frontend:** TypeScript + Vite. Plain DOM — the view is a list, no framework needed.
- **System data:** [`sysinfo`](https://crates.io/crates/sysinfo) crate (Rust) — per-pid CPU%, RSS memory, process name, parent pid, total RAM, core count, load average.
- **App grouping:** read `/proc/<pid>/cgroup` directly (systemd scope), with fallbacks. See *Grouping* below.
- **Chrome + palette:** [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui) v0.6.0+.
- **State / fs / dev / updater:** [`krill-desktop-core`](https://github.com/krill-software/desktop-core) v0.2.0+.

## Grouping — processes → applications

The core problem: Firefox is 20+ processes, a build is `cargo` + `rustc` × N, etc. Showing per-process is noise. The app rolls processes up into **groups** and sums their CPU + memory.

Resolution chain, first match wins:

1. **systemd cgroup scope.** `/proc/<pid>/cgroup` on a systemd desktop yields a line like `0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-firefox@1.scope`. Extract the `app-<name>` token → group `firefox`. This is the clean path and covers GNOME, KDE, and most modern desktops.
2. **Executable basename.** No app scope (daemons, CLI tools, non-systemd sessions) → group by the basename of the executable (`/proc/<pid>/exe` target, or `sysinfo`'s process name). `rustc`, `node`, `sshd`.
3. **Kernel threads / unknowable** → a single collapsed group `System`.

Each group shows: a display name (cgroup app id title-cased, or the basename), the rolled-up CPU%, the rolled-up memory (absolute + % of RAM), and the process count in the group.

## Status thresholds (baked, no setting)

Two independent traffic lights per group — one for CPU, one for memory — and the **row's overall status is the worse of the two**.

**CPU** — group CPU% is summed across the group's processes, then divided by core count so "100%" means "one core's worth":

| Status | Group CPU (normalized to one core) |
|--------|------------------------------------|
| OK     | < 25%   |
| Warn   | 25 – 60% |
| High   | > 60%   |

**Memory** — group RSS as a fraction of total system RAM:

| Status | Group memory (% of total RAM) |
|--------|-------------------------------|
| OK     | < 8%    |
| Warn   | 8 – 20%  |
| High   | > 20%   |

These are starting values — tune during M2 against real machines. They live as constants in one Rust module, not as user settings.

## Session history — "what changed?"

On launch the app snapshots each group's memory. Every refresh it keeps a small ring buffer (last ~60 samples) per group. From that it derives two badges:

- **Climbing** — memory has grown by more than ~50% since the session's first sample for that group. Rendered as a small "↑ since you opened this" note.
- **New** — the group did not exist at launch and appeared during the session. Rendered as "started N min ago".

This is the feature that turns a colored `top` into an actual answer. History is in-memory only — nothing persisted, nothing across launches.

## Layout

Single-pane, no aux. (Quiet app — reading, not manipulating — so the working view stays chrome-free per STYLE.md → Discoverability.)

```
┌──────────────────────────────────────────────┐
│ titlebar — System Monitor                   │
├──────────────────────────────────────────────┤
│  SYSTEM                                       │
│  CPU  ▓▓▓▓▓░░░░░  38%      Memory  ▓▓▓▓▓▓░  61%│
│                                                │
│  APPLICATIONS                    cpu     mem   │
│  ● firefox          ↑ climbing   52%    18%    │
│  ● code                          22%     9%    │
│  ● rustc            started 2m   88%     4%    │
│  ● gnome-shell                    6%     5%    │
│  ● System                         3%    11%    │
│  …                                             │
├──────────────────────────────────────────────┤
│ status — 5 apps · updated 2s ago               │
└──────────────────────────────────────────────┘
```

- **System strip**: two bars, CPU and memory, each with its own traffic-light tint.
- **Applications list**: one row per group, sorted by the worse of its two statuses (high first), then by CPU within a status. The `●` dot is the row status color. CPU and memory columns are mono, right-aligned, tabular-nums. Badges (climbing / new) sit between the name and the numbers in muted text.
- Each numeric cell carries its own subtle status tint so you can see *which* metric is the problem, not just that the row is hot.
- **Status line**: group count on the left, "updated Ns ago" on the right.

## Refresh

- Rust side runs a background thread; `sysinfo` refreshes every **2 seconds** (CPU% needs two spaced samples — first tick after launch shows "—" until the second sample lands).
- Each tick emits a Tauri event with the full grouped snapshot. The frontend re-renders the list in place — groups are keyed by group id so rows are stable and don't flicker.
- ~15-20 group rows; no virtualization needed.

## Color — domain-essential exception

The traffic light needs three distinguishable statuses. The locked palette has none of green/amber/red, so this is a **domain-essential color exception** (sanctioned in CLAUDE.md → "status colors on a dashboard").

To stay krill-calm, only **two** new tokens are introduced — the third reuses the brand:

| Status | Token | Value | Rationale |
|--------|-------|-------|-----------|
| OK     | `--status-ok`   | a muted sage green (~`#6E8C6A`) | calm, clearly "fine" |
| Warn   | `--status-warn` | a soft amber (~`#C9A85A`) | mid-tone, no alarm |
| High   | `--status-high` | `var(--fm-accent)` Shimmering Blush | the brand pink already reads as "attention, look here" |

Declared as app-local tokens in `styles.css` with a comment explaining the exception. Final hexes are picked during M1 against both light and dark backgrounds — they must read on `--fm-bg` in either system theme.

## Window

- Single window. Compact default size (~520 × 640) — it's a glance tool, not a workspace.
- Window geometry persisted to `$XDG_STATE_HOME/krill-system-monitor/state.json`.
- No CLI args, no file associations — the app takes no input.

## Linux integration

- Slug / directory / repo: `system-monitor`. Identifier `software.krill.system-monitor`.
- productName `System Monitor`; binary + `.deb` package `krill-system-monitor`.
- Distribution: AppImage + `.deb` via the shared `krill-app-release.yml`.
- In-app updater wired (`mountChrome({ updater: true })`, `with_updater()`).

## Milestones

1. **M1 — Glance works.** sysinfo polling thread, cgroup grouping with the basename fallback, system CPU/mem strip, the applications list with the three-state traffic light, baked thresholds. No history yet. The app should already answer "which app is hot."
2. **M2 — History.** Per-group ring buffer; "climbing" and "new" badges. Tune thresholds against real load.
3. **M3 — Polish.** Inline sparkline per row (last ~60s of the row's worse metric), empty/▒error states, status-line "updated Ns ago", dark-mode pass on the three status colors.
4. **M4 — Packaging.** Icon (Lucide `activity` or `gauge`), `.desktop` file, AppImage + `.deb`, updater endpoint.

## Out of scope / open questions

- **Force-kill (SIGKILL).** v1 only sends SIGTERM. A "force quit" escalation that sends SIGKILL after a couple of seconds without exit is a possible polish add — deferred until v1 use shows it's actually needed.
- **Per-core CPU breakdown.** The system strip is one aggregate bar in v1. A per-core mini-grid is a possible M3 nicety.
- **Swap pressure / `PSI`.** Linux `/proc/pressure/*` gives a truer "is the machine actually struggling" signal than raw percentages. Worth investigating for M2's threshold tuning — it might replace the naive memory-% rule.
- **GPU usage.** Out of scope — no stable cross-vendor Linux API worth depending on.
- **What counts as "an app"** for things with no cgroup scope and a generic name (`python`, `node`) — basename grouping will lump unrelated `node` processes together. Acceptable for v1; revisit if it proves confusing.
