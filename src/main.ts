import "@krill-software/desktop-ui/styles";
import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  buildFilterInput,
  buildLoader,
  mountChrome,
  showBootError,
} from "@krill-software/desktop-ui";

// ---- Types (mirror Rust's Snapshot / GroupRow) ----------------------

type Status = "ok" | "warn" | "high";
type View = "cpu" | "memory" | "storage" | "docker" | "gpu";

type GpuAvailability =
  | { kind: "none" }
  | { kind: "detected"; vendor: string; name: string; live: boolean };

interface Capabilities {
  docker: boolean;
  gpu: GpuAvailability;
}

interface DockerImage {
  label: string;
  repo: string;
  tag: string;
  id: string;
  size_bytes: number;
  size_human: string;
  created: string;
}

interface GpuStats {
  name: string;
  mem_used_mb: number;
  mem_total_mb: number;
  util_pct: number;
}

interface GroupRow {
  id: string;
  name: string;
  pids: number[];
  cpu_per_core: number; // 100 = one full core
  mem_bytes: number;
  mem_frac: number;     // 0..1
}

interface KillReport {
  killed: number;
  failed: number[];
}

interface DirRow {
  id: string;
  label: string;
  bytes: number;
  frac: number;
  is_dir: boolean;
}

interface StorageSnapshot {
  mount: string;
  total: number;
  used: number;
  free: number;
  categories: DirRow[];
}

/** One level in the drill-down history. Top-level is always the
 *  storage snapshot itself ({ label: "Storage", rows: snapshot.categories }). */
interface StorageLevel {
  label: string;
  path: string | null;   // null for the top level
  rows: DirRow[];
}

interface Snapshot {
  cpu_total: number;    // 0..100
  mem_frac: number;     // 0..1
  mem_total: number;
  cores: number;
  first_sample: boolean;
  groups: GroupRow[];
}

// ---- Thresholds (baked, see SPEC.md) --------------------------------

function cpuStatus(cpuPerCore: number): Status {
  if (cpuPerCore < 25) return "ok";
  if (cpuPerCore < 60) return "warn";
  return "high";
}
function memStatus(memFrac: number): Status {
  if (memFrac < 0.08) return "ok";
  if (memFrac < 0.20) return "warn";
  return "high";
}

// ---- DOM refs -------------------------------------------------------

let auxEl: HTMLElement;
let mainContentEl: HTMLElement;

let view: View = "cpu";
let lastSnap: Snapshot | null = null;
/** Case-insensitive substring filter applied to group names in the
 *  application list. Empty string = no filter. */
let filterText = "";

/** Storage data + drill-down stack. The first entry is always the
 *  top-level snapshot; subsequent entries are user-driven drill-downs. */
let storageSnap: StorageSnapshot | null = null;
let storageStack: StorageLevel[] = [];
let storageBusy = false;
let storageError: string | null = null;
/** Substring filter applied to the current storage level. */
let storageFilterText = "";

/** What the host machine can do — what tabs are active vs. muted. */
let caps: Capabilities = { docker: false, gpu: { kind: "none" } };

/** Docker scan state — same shape as storage's. */
let dockerImages: DockerImage[] | null = null;
let dockerBusy = false;
let dockerError: string | null = null;
let dockerFilterText = "";

/** GPU live stats. Polled every 2s while the GPU tab is mounted. */
let gpuStats: GpuStats | null = null;
let gpuError: string | null = null;
let gpuTimer: number | undefined;

// ---- Formatters -----------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function formatPct(x: number): string {
  return `${Math.round(x)}%`;
}

// ---- Aux sidebar — category nav -------------------------------------

const VIEWS: Array<{ id: View; label: string; icon: string }> = [
  { id: "cpu",     label: "CPU",     icon: "cpu" },
  { id: "memory",  label: "Memory",  icon: "memory" },
  { id: "storage", label: "Storage", icon: "hard-drive" },
  { id: "docker",  label: "Docker",  icon: "container" },
  { id: "gpu",     label: "GPU",     icon: "monitor" },
];

/** Is a view available on this host? CPU/memory/storage always are;
 *  docker and gpu are gated on capability detection. */
function viewAvailable(id: View): boolean {
  switch (id) {
    case "cpu":
    case "memory":
    case "storage":
      return true;
    case "docker": return caps.docker;
    case "gpu":    return caps.gpu.kind === "detected";
  }
}

function viewDisabledReason(id: View): string | null {
  if (viewAvailable(id)) return null;
  if (id === "docker") return "Docker not installed or daemon not running";
  if (id === "gpu")    return "No GPU detected";
  return null;
}

function renderAux(): void {
  // The aux strip (hamburger) is owned by desktop-ui's app layout — keep it
  // and re-render only system-monitor's own nav content below it.
  const strip = auxEl.querySelector(".aux-topbar");
  auxEl.replaceChildren();
  if (strip) auxEl.append(strip);

  for (const item of VIEWS) {
    const available = viewAvailable(item.id);
    const reason = viewDisabledReason(item.id);
    const btn = el("button", {
      class: "aux-item",
      type: "button",
      "data-view": item.id,
      "data-active": item.id === view ? "true" : "false",
      "data-disabled": available ? "false" : "true",
      title: reason ?? item.label,
      ...(available ? {} : { disabled: "" }),
    });
    btn.append(iconSvg(item.icon, "aux-icon"));

    // Each row is: [icon] [body { head: label + pct }, bar].
    const body = el("div", { class: "aux-body" });
    const head = el("div", { class: "aux-head" });
    head.append(el("span", { class: "aux-label" }, item.label));
    head.append(el("span", { class: "aux-pct", "data-view": item.id }, "—"));
    body.append(head);
    const bar = el("div", { class: "aux-bar" });
    bar.append(el("div", { class: "aux-fill", "data-view": item.id }));
    body.append(bar);
    btn.append(body);

    if (available) {
      btn.addEventListener("click", () => {
        if (view === item.id) return;
        view = item.id;
        for (const b of auxEl.querySelectorAll<HTMLElement>(".aux-item")) {
          b.dataset.active = b.dataset.view === view ? "true" : "false";
        }
        renderMain();
      });
    }
    auxEl.append(btn);
  }

  updateAuxValues();
}

/** Refresh the percentage / bar fill on each sidebar nav row from
 *  the latest snapshot. Storage has no data source yet so its row
 *  stays at "—" / 0%. */
function updateAuxValues(): void {
  for (const item of VIEWS) {
    const pctEl = auxEl.querySelector<HTMLElement>(`.aux-pct[data-view="${item.id}"]`);
    const fillEl = auxEl.querySelector<HTMLElement>(`.aux-fill[data-view="${item.id}"]`);
    const itemEl = auxEl.querySelector<HTMLElement>(`.aux-item[data-view="${item.id}"]`);
    if (!pctEl || !fillEl || !itemEl) continue;

    if (!viewAvailable(item.id)) {
      pctEl.textContent = "";
      fillEl.style.width = "0%";
      itemEl.dataset.status = "ok";
      continue;
    }

    if (item.id === "cpu") {
      if (!lastSnap) { pctEl.textContent = "—"; fillEl.style.width = "0%"; continue; }
      const pct = lastSnap.cpu_total;
      pctEl.textContent = lastSnap.first_sample ? "—" : formatPct(pct);
      fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      itemEl.dataset.status = cpuStatus(pct);
    } else if (item.id === "memory") {
      if (!lastSnap) { pctEl.textContent = "—"; fillEl.style.width = "0%"; continue; }
      const pct = lastSnap.mem_frac * 100;
      pctEl.textContent = formatPct(pct);
      fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      itemEl.dataset.status = memStatus(lastSnap.mem_frac);
    } else if (item.id === "storage") {
      // Storage is on-demand; nothing live to put in the sidebar slot.
      if (storageSnap) {
        const pct = storageSnap.total > 0 ? storageSnap.used / storageSnap.total * 100 : 0;
        pctEl.textContent = formatPct(pct);
        fillEl.style.width = `${pct}%`;
        const usedFrac = storageSnap.total > 0 ? storageSnap.used / storageSnap.total : 0;
        itemEl.dataset.status = usedFrac < 0.85 ? "ok" : usedFrac < 0.95 ? "warn" : "high";
      } else {
        pctEl.textContent = "—";
        fillEl.style.width = "0%";
        itemEl.dataset.status = "ok";
      }
    } else if (item.id === "docker") {
      // No "%" for docker — show image count if scanned, else "—".
      if (dockerImages) {
        pctEl.textContent = `${dockerImages.length}`;
      } else {
        pctEl.textContent = "—";
      }
      fillEl.style.width = "0%";
      itemEl.dataset.status = "ok";
    } else if (item.id === "gpu") {
      if (caps.gpu.kind === "detected" && caps.gpu.live && gpuStats) {
        pctEl.textContent = formatPct(gpuStats.util_pct);
        fillEl.style.width = `${gpuStats.util_pct}%`;
        // Reuse cpu thresholds for GPU util (one-load metric).
        itemEl.dataset.status = cpuStatus(gpuStats.util_pct);
      } else {
        pctEl.textContent = "—";
        fillEl.style.width = "0%";
        itemEl.dataset.status = "ok";
      }
    }
  }
}

// ---- Main pane ------------------------------------------------------

/** Currently-mounted view shape; lets `updateMain` know it can patch
 *  in place rather than rebuild. Reset to null on view switches. */
let mountedView: View | null = null;

function renderMain(): void {
  if (view !== mountedView) {
    mountMain();
  }
  updateMain();
}

/** Build the skeleton for the active view. Idempotent within a view;
 *  preserves no state (filter input, scroll, etc. — those are kept
 *  intact by updateMain's in-place patching across ticks). */
function mountMain(): void {
  // Tear down per-view bookkeeping that the previous view set up.
  if (gpuTimer !== undefined) { clearInterval(gpuTimer); gpuTimer = undefined; }
  mainContentEl.replaceChildren();
  mountedView = view;
  if (view === "storage") { mountStorage(); return; }
  if (view === "docker")  { mountDocker(); return; }
  if (view === "gpu")     { mountGpu(); return; }
  // System strip section (live container — value + bar update inline).
  const sys = el("section", { class: "section sys-item sys-big", id: "system-section" });
  const head = el("div", { class: "sys-head" });
  head.append(el("span", { class: "sys-label", id: "sys-label" }, ""));
  head.append(el("span", { class: "sys-value", id: "sys-value" }, "—"));
  sys.append(head);
  const bar = el("div", { class: "sys-bar" });
  const fill = el("div", { class: "sys-fill", id: "sys-fill" });
  bar.append(fill);
  sys.append(bar);
  sys.append(el("div", { class: "sys-sub", id: "sys-sub" }, ""));
  mainContentEl.append(sys);

  // Filter + header + rows-list. Filter persists across ticks; only
  // rows-list is repopulated when data changes. Filter primitive comes
  // from desktop-ui so the input shape matches every other krill list
  // filter (storage, photo-importer, etc.).
  const apps = el("section", { class: "section" });
  const filter = buildFilterInput({
    placeholder: "Filter by name…",
    value: filterText,
    onChange: (v) => {
      filterText = v;
      if (lastSnap) renderRowList(lastSnap);
    },
  });
  apps.append(filter.element);

  const headRow = el("div", { class: "row row-head row-proc" });
  headRow.append(el("div", { class: "cell cell-name" }, ""));
  headRow.append(el("div", { class: "cell cell-pid" }, "pid"));
  headRow.append(el("div", { class: "cell cell-value", id: "rows-head-value" },
    view === "cpu" ? "cpu" : "memory"));
  headRow.append(el("div", { class: "cell cell-kill" }, ""));
  apps.append(headRow);

  const list = el("div", { id: "rows-list" });
  apps.append(list);

  mainContentEl.append(apps);
}

/** Push the latest snapshot into the mounted view's live containers. */
function updateMain(): void {
  if (view === "cpu" || view === "memory") {
    if (!lastSnap) return;
    renderSystem(lastSnap);
    renderRowList(lastSnap);
  }
}

function renderSystem(snap: Snapshot): void {
  const sec = document.getElementById("system-section");
  const labelEl = document.getElementById("sys-label");
  const valueEl = document.getElementById("sys-value");
  const fillEl = document.getElementById("sys-fill");
  const subEl = document.getElementById("sys-sub");
  if (!sec || !labelEl || !valueEl || !fillEl || !subEl) return;

  const label = view === "cpu" ? "CPU" : "Memory";
  const status: Status = view === "cpu" ? cpuStatus(snap.cpu_total)
                                        : memStatus(snap.mem_frac);
  const pct = view === "cpu" ? snap.cpu_total : snap.mem_frac * 100;
  const valueText = snap.first_sample && view === "cpu" ? "—" : formatPct(pct);
  const sub = view === "cpu"
    ? `${snap.cores} cores`
    : `${formatBytes(snap.mem_total * snap.mem_frac)} of ${formatBytes(snap.mem_total)}`;

  sec.dataset.status = status;
  labelEl.textContent = label;
  valueEl.textContent = valueText;
  fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  subEl.textContent = sub;
}

/** PID column text for a group. Pids arrive sorted ascending, so the
 *  first is the lowest — the group's "leader". A single-process group
 *  shows just that pid; a multi-process group appends the overflow
 *  count; the synthetic System bucket has no pids, so it shows a dash. */
function pidLabel(pids: number[]): string {
  if (pids.length === 0) return "—";
  if (pids.length === 1) return String(pids[0]);
  return `${pids[0]} (+${pids.length - 1} more)`;
}

/** Replace just the rows-list contents. The filter input + the
 *  section's header row are kept intact — that's what keeps focus
 *  + caret stable across both ticks and view-internal re-renders. */
function renderRowList(snap: Snapshot): void {
  const list = document.getElementById("rows-list");
  if (!list) return;
  list.replaceChildren();

  const needle = filterText.trim().toLowerCase();
  const matches = snap.groups.filter((g) =>
    needle === "" ? true : g.name.toLowerCase().includes(needle),
  );
  matches.sort((a, b) => view === "cpu"
    ? b.cpu_per_core - a.cpu_per_core
    : b.mem_frac - a.mem_frac);

  if (matches.length === 0) {
    list.append(el("div", { class: "placeholder" },
      needle === "" ? "Nothing notable yet." : "No matches."));
    return;
  }

  for (const g of matches) {
    const status: Status = view === "cpu" ? cpuStatus(g.cpu_per_core)
                                          : memStatus(g.mem_frac);
    const valueText = view === "cpu"
      ? (snap.first_sample ? "—" : formatPct(g.cpu_per_core))
      : formatBytes(g.mem_bytes);

    const row = el("div", { class: "row row-proc", "data-status": status });
    const name = el("div", { class: "cell cell-name" });
    const dot = el("span", { class: "dot", "data-status": status });
    name.append(dot, el("span", { class: "name" }, g.name));
    row.append(name);
    row.append(el("div", { class: "cell cell-pid" }, pidLabel(g.pids)));
    const value = el("div", { class: "cell cell-value", "data-status": status }, valueText);
    row.append(value);

    // Keep the cell for grid alignment, but only offer a kill button when
    // there's actually something to signal. The synthetic "System" row that
    // absorbs shared/kernel memory carries no pids — nothing to quit.
    const killCell = el("div", { class: "cell cell-kill" });
    if (g.pids.length > 0) {
      const killBtn = el("button", {
        class: "kill-btn",
        type: "button",
        title: `Quit ${g.name} (${g.pids.length} ${g.pids.length === 1 ? "process" : "processes"})`,
      });
      killBtn.append(iconSvg("x-square", "kill-icon"));
      killBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void killGroup(g);
      });
      killCell.append(killBtn);
    }
    row.append(killCell);

    list.append(row);
  }
}

/** Prompt + send SIGTERM to every pid in the group. */
async function killGroup(g: GroupRow): Promise<void> {
  const procsLabel = g.pids.length === 1 ? "1 process" : `${g.pids.length} processes`;
  const ok = window.confirm(`Quit ${g.name} (${procsLabel})?\n\nA SIGTERM is sent so the app can clean up. Use a system tool if it doesn't respond.`);
  if (!ok) return;
  try {
    const report = await invoke<KillReport>("kill_group", { pids: g.pids });
    if (report.failed.length > 0) {
      console.warn(`kill_group: ${report.killed} signalled, ${report.failed.length} failed (probably permission). pids: ${report.failed.join(", ")}`);
    }
  } catch (e) {
    console.error("kill_group failed:", e);
  }
}

// ---- Storage view ---------------------------------------------------

function diskStatus(usedFrac: number): Status {
  if (usedFrac < 0.85) return "ok";
  if (usedFrac < 0.95) return "warn";
  return "high";
}

function mountStorage(): void {
  // Disk usage strip — same shape as CPU/Memory.
  const sys = el("section", { class: "section sys-item sys-big", id: "storage-strip" });
  const head = el("div", { class: "sys-head" });
  head.append(el("span", { class: "sys-label" }, "Disk"));
  head.append(el("span", { class: "sys-value", id: "storage-value" }, "—"));
  sys.append(head);
  const bar = el("div", { class: "sys-bar" });
  bar.append(el("div", { class: "sys-fill", id: "storage-fill" }));
  sys.append(bar);
  sys.append(el("div", { class: "sys-sub", id: "storage-sub" }, ""));
  mainContentEl.append(sys);

  // Breadcrumb + refresh row.
  const navRow = el("section", { class: "section storage-nav" });
  navRow.append(el("div", { class: "breadcrumb", id: "storage-crumb" }));
  const refresh = el("button", {
    class: "storage-refresh",
    type: "button",
    title: "Re-scan",
  }, "Refresh");
  refresh.addEventListener("click", () => { void refreshStorage(); });
  navRow.append(refresh);
  mainContentEl.append(navRow);

  // Row list container — replaced when the user drills in/out.
  const list = el("div", { id: "storage-list" });
  mainContentEl.append(list);

  // First-time scan if we don't have data yet.
  if (storageSnap === null && !storageBusy) {
    void refreshStorage();
  } else {
    renderStorageStrip();
    renderStorageList();
  }
}

async function refreshStorage(): Promise<void> {
  if (storageBusy) return;
  storageBusy = true;
  storageError = null;
  storageStack = []; // forces the "Scanning…" loader to render
  storageFilterText = "";
  renderStorageList();
  try {
    storageSnap = await invoke<StorageSnapshot>("scan_storage");
    storageStack = [{
      label: "Storage",
      path: null,
      rows: storageSnap.categories,
    }];
  } catch (e) {
    console.error("scan_storage failed:", e);
    storageSnap = null;
    storageError = String(e);
  } finally {
    storageBusy = false;
    renderStorageStrip();
    renderStorageList();
  }
}

async function drillInto(row: DirRow): Promise<void> {
  if (!row.is_dir || storageBusy) return;
  storageBusy = true;
  // Push a placeholder onto the stack so the breadcrumb updates while
  // we wait — feels more responsive than freezing the UI.
  storageStack.push({ label: row.label, path: row.id, rows: [] });
  renderStorageList();
  try {
    const rows = await invoke<DirRow[]>("scan_category", { path: row.id });
    storageStack[storageStack.length - 1].rows = rows;
  } catch (e) {
    console.error("scan_category failed:", e);
    storageStack.pop();
  } finally {
    storageBusy = false;
    renderStorageList();
  }
}

function popTo(level: number): void {
  if (level >= storageStack.length - 1) return;
  storageStack.length = level + 1;
  renderStorageList();
}

function renderStorageStrip(): void {
  const valueEl = document.getElementById("storage-value");
  const fillEl = document.getElementById("storage-fill");
  const subEl = document.getElementById("storage-sub");
  const stripEl = document.getElementById("storage-strip");
  if (!valueEl || !fillEl || !subEl || !stripEl) return;
  if (!storageSnap) {
    valueEl.textContent = "—";
    fillEl.style.width = "0%";
    subEl.textContent = "Not scanned";
    stripEl.dataset.status = "ok";
    return;
  }
  const usedFrac = storageSnap.total > 0
    ? storageSnap.used / storageSnap.total
    : 0;
  const status = diskStatus(usedFrac);
  const pct = Math.round(usedFrac * 100);
  valueEl.textContent = `${pct}%`;
  fillEl.style.width = `${pct}%`;
  subEl.textContent = `${formatBytes(storageSnap.used)} used of ${formatBytes(storageSnap.total)} · ${storageSnap.mount}`;
  stripEl.dataset.status = status;
}

function renderStorageList(): void {
  renderBreadcrumb();
  const list = document.getElementById("storage-list");
  if (!list) return;
  list.replaceChildren();

  // A scan is in flight AND we don't have a previous level's data to
  // keep showing — render the loader. Initial scans hit this path
  // because the stack is still empty; drill-downs hit it because the
  // pending stack entry has rows: [].
  const current = storageStack[storageStack.length - 1];
  if (storageBusy && (!current || current.rows.length === 0)) {
    const wrap = el("div", { class: "placeholder" });
    wrap.append(buildLoader({ label: "Scanning…" }));
    list.append(wrap);
    return;
  }
  if (storageSnap === null) {
    list.append(el("div", { class: "placeholder" }, "Couldn't scan disk."));
    if (storageError) {
      const errBox = el("pre", { class: "storage-error" }, storageError);
      list.append(errBox);
    }
    return;
  }
  if (!current || current.rows.length === 0) {
    list.append(el("div", { class: "placeholder" }, "Empty."));
    return;
  }

  // Filter input — case-insensitive substring against row labels.
  // Lives at the top of the rows list; persists across drill-down via
  // the module-level storageFilterText so typing isn't lost on
  // re-render. Comes from desktop-ui so the input shape matches the
  // CPU/Memory filter and any other krill list filter.
  const filter = buildFilterInput({
    placeholder: "Filter by name…",
    value: storageFilterText,
    onChange: (v) => {
      const caretStart = filter.input.selectionStart;
      const caretEnd = filter.input.selectionEnd;
      storageFilterText = v;
      renderStorageList();
      const fresh = document.querySelector<HTMLInputElement>(".fm-filter-input");
      if (fresh) {
        fresh.focus();
        try {
          fresh.setSelectionRange(caretStart ?? v.length, caretEnd ?? v.length);
        } catch { /* selection unavailable */ }
      }
    },
  });
  list.append(filter.element);

  const needle = storageFilterText.trim().toLowerCase();
  const filtered = needle === ""
    ? current.rows
    : current.rows.filter((r) => r.label.toLowerCase().includes(needle));

  if (filtered.length === 0) {
    list.append(el("div", { class: "placeholder" }, "No matches."));
    return;
  }

  // The category fractions are vs. the whole disk; drill-down
  // fractions are vs. the parent dir. The bar fill uses whichever
  // applies — directly from `row.frac` — and the dot uses memStatus's
  // thresholds (>8% warn, >20% high), which feel right both for "this
  // chunk of disk" and "this child of a folder".
  for (const row of filtered) {
    const status = memStatus(row.frac);
    const rowEl = el("div", { class: "row storage-row", "data-status": status });

    const name = el("div", { class: "cell cell-name" });
    name.append(iconSvg(row.is_dir ? "folder" : "file-text", "row-icon"));
    name.append(el("span", { class: "name" }, row.label));
    rowEl.append(name);

    // Bar showing the row's fraction.
    const barWrap = el("div", { class: "cell cell-bar" });
    const bar = el("div", { class: "row-bar" });
    const fill = el("div", { class: "row-fill", "data-status": status });
    fill.style.width = `${Math.min(100, Math.max(0, row.frac * 100))}%`;
    bar.append(fill);
    barWrap.append(bar);
    rowEl.append(barWrap);

    rowEl.append(el("div", { class: "cell cell-value", "data-status": status }, formatBytes(row.bytes)));

    // Open in file manager (xdg-open). Hidden until row hover.
    const actionsCell = el("div", { class: "cell cell-kill storage-actions" });
    const openBtn = el("button", {
      class: "kill-btn",
      type: "button",
      title: `Open ${row.label} in file manager`,
    });
    openBtn.append(iconSvg("external-link", "kill-icon"));
    openBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void invoke("open_path", { path: row.id }).catch((e) => console.error("open_path failed:", e));
    });
    actionsCell.append(openBtn);
    rowEl.append(actionsCell);

    if (row.is_dir) {
      rowEl.classList.add("clickable");
      rowEl.addEventListener("click", () => { void drillInto(row); });
    }

    list.append(rowEl);
  }
}

// ---- Docker view ----------------------------------------------------

function mountDocker(): void {
  // Compact header: count + Refresh. No system strip — there's no
  // single percentage that summarizes "the docker stash".
  const head = el("section", { class: "section storage-nav" });
  head.append(el("div", { class: "breadcrumb", id: "docker-summary" }, "—"));
  const refresh = el("button", {
    class: "storage-refresh",
    type: "button",
    title: "Re-scan Docker images",
  }, "Refresh");
  refresh.addEventListener("click", () => { void refreshDocker(); });
  head.append(refresh);
  mainContentEl.append(head);

  const list = el("div", { id: "docker-list" });
  mainContentEl.append(list);

  if (dockerImages === null && !dockerBusy) {
    void refreshDocker();
  } else {
    renderDockerList();
  }
}

async function refreshDocker(): Promise<void> {
  if (dockerBusy) return;
  dockerBusy = true;
  dockerError = null;
  dockerFilterText = "";
  renderDockerList();
  try {
    dockerImages = await invoke<DockerImage[]>("list_docker_images");
  } catch (e) {
    console.error("list_docker_images failed:", e);
    dockerImages = null;
    dockerError = String(e);
  } finally {
    dockerBusy = false;
    renderDockerList();
    updateAuxValues();
  }
}

function renderDockerList(): void {
  const summary = document.getElementById("docker-summary");
  const list = document.getElementById("docker-list");
  if (!list) return;
  list.replaceChildren();

  if (dockerBusy) {
    list.append(buildLoader({ label: "Loading images…" }));
    if (summary) summary.textContent = "—";
    return;
  }
  if (dockerImages === null) {
    list.append(el("div", { class: "placeholder" }, "Couldn't list Docker images."));
    if (dockerError) list.append(el("pre", { class: "storage-error" }, dockerError));
    if (summary) summary.textContent = "—";
    return;
  }
  if (dockerImages.length === 0) {
    list.append(el("div", { class: "placeholder" }, "No Docker images."));
    if (summary) summary.textContent = "0 images";
    return;
  }

  const totalBytes = dockerImages.reduce((acc, im) => acc + im.size_bytes, 0);
  if (summary) {
    summary.textContent = `${dockerImages.length} ${dockerImages.length === 1 ? "image" : "images"} · ${formatBytes(totalBytes)} total`;
  }

  const filter = buildFilterInput({
    placeholder: "Filter by image…",
    value: dockerFilterText,
    onChange: (v) => {
      const caretStart = filter.input.selectionStart;
      const caretEnd = filter.input.selectionEnd;
      dockerFilterText = v;
      renderDockerList();
      const fresh = document.querySelector<HTMLInputElement>(".fm-filter-input");
      if (fresh) {
        fresh.focus();
        try {
          fresh.setSelectionRange(caretStart ?? v.length, caretEnd ?? v.length);
        } catch { /* selection unavailable */ }
      }
    },
  });
  list.append(filter.element);

  const needle = dockerFilterText.trim().toLowerCase();
  const matches = needle === ""
    ? dockerImages
    : dockerImages.filter((im) =>
        im.label.toLowerCase().includes(needle) ||
        im.id.toLowerCase().includes(needle),
      );

  if (matches.length === 0) {
    list.append(el("div", { class: "placeholder" }, "No matches."));
    return;
  }

  for (const im of matches) {
    // Status colored by share of the total stash — same OK/warn/high
    // mem thresholds (>8% warn, >20% high) so a single 12GB image
    // stands out without being "the worst always".
    const frac = totalBytes > 0 ? im.size_bytes / totalBytes : 0;
    const status: Status = memStatus(frac);

    const row = el("div", { class: "row storage-row", "data-status": status });
    const name = el("div", { class: "cell cell-name" });
    name.append(iconSvg("container", "row-icon"));
    const nameCol = el("div", { class: "docker-name-col" });
    nameCol.append(el("div", { class: "name" }, im.label));
    nameCol.append(el("div", { class: "docker-meta" }, `${im.id.slice(0, 12)} · ${im.created}`));
    name.append(nameCol);
    row.append(name);

    const barWrap = el("div", { class: "cell cell-bar" });
    const bar = el("div", { class: "row-bar" });
    const fill = el("div", { class: "row-fill", "data-status": status });
    fill.style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
    bar.append(fill);
    barWrap.append(bar);
    row.append(barWrap);

    row.append(el("div", { class: "cell cell-value", "data-status": status }, im.size_human));

    // No "open" action for docker rows in v1 — there's no obvious
    // single thing to do per image. (Future: copy `docker rmi <id>`
    // command, surface a remove-with-confirm button.)
    row.append(el("div", { class: "cell cell-kill" }));

    list.append(row);
  }
}

// ---- GPU view -------------------------------------------------------

function mountGpu(): void {
  if (caps.gpu.kind !== "detected") return;
  const live = caps.gpu.live;

  // System strip — GPU utilization. Mirrors CPU/Memory.
  const sys = el("section", { class: "section sys-item sys-big", id: "gpu-strip" });
  const head = el("div", { class: "sys-head" });
  head.append(el("span", { class: "sys-label" }, "GPU"));
  head.append(el("span", { class: "sys-value", id: "gpu-value" }, live ? "—" : "—"));
  sys.append(head);
  const bar = el("div", { class: "sys-bar" });
  bar.append(el("div", { class: "sys-fill", id: "gpu-fill" }));
  sys.append(bar);
  sys.append(el("div", { class: "sys-sub", id: "gpu-sub" }, caps.gpu.name));
  mainContentEl.append(sys);

  // Memory strip below — separate "use vs. capacity" bar for VRAM.
  if (live) {
    const mem = el("section", { class: "section sys-item", id: "gpu-mem-strip" });
    const mhead = el("div", { class: "sys-head" });
    mhead.append(el("span", { class: "sys-label" }, "VRAM"));
    mhead.append(el("span", { class: "sys-value", id: "gpu-mem-value" }, "—"));
    mem.append(mhead);
    const mbar = el("div", { class: "sys-bar" });
    mbar.append(el("div", { class: "sys-fill", id: "gpu-mem-fill" }));
    mem.append(mbar);
    mem.append(el("div", { class: "sys-sub", id: "gpu-mem-sub" }, ""));
    mainContentEl.append(mem);
  } else {
    mainContentEl.append(el("div", { class: "placeholder" },
      `Live stats not available for ${caps.gpu.vendor} GPUs in v1 — only NVIDIA is supported.`));
    return;
  }

  // Kick a first poll, then settle into the 2s cadence.
  void pollGpu();
  gpuTimer = window.setInterval(() => { void pollGpu(); }, 2000);
}

async function pollGpu(): Promise<void> {
  try {
    gpuStats = await invoke<GpuStats>("nvidia_gpu_stats");
    gpuError = null;
    renderGpu();
    updateAuxValues();
  } catch (e) {
    console.warn("nvidia_gpu_stats failed:", e);
    gpuError = String(e);
    renderGpu();
  }
}

function renderGpu(): void {
  const valueEl = document.getElementById("gpu-value");
  const fillEl  = document.getElementById("gpu-fill");
  const subEl   = document.getElementById("gpu-sub");
  const stripEl = document.getElementById("gpu-strip");
  if (!valueEl || !fillEl || !subEl || !stripEl) return;

  if (!gpuStats) {
    valueEl.textContent = gpuError ? "error" : "—";
    fillEl.style.width = "0%";
    return;
  }

  const util = gpuStats.util_pct;
  const status: Status = cpuStatus(util);
  stripEl.dataset.status = status;
  valueEl.textContent = formatPct(util);
  fillEl.style.width = `${util}%`;
  subEl.textContent = gpuStats.name;

  const memValueEl = document.getElementById("gpu-mem-value");
  const memFillEl  = document.getElementById("gpu-mem-fill");
  const memSubEl   = document.getElementById("gpu-mem-sub");
  const memStripEl = document.getElementById("gpu-mem-strip");
  if (memValueEl && memFillEl && memSubEl && memStripEl && gpuStats.mem_total_mb > 0) {
    const memFrac = gpuStats.mem_used_mb / gpuStats.mem_total_mb;
    const memStat: Status = memStatus(memFrac);
    memStripEl.dataset.status = memStat;
    memValueEl.textContent = formatPct(memFrac * 100);
    memFillEl.style.width = `${memFrac * 100}%`;
    memSubEl.textContent = `${gpuStats.mem_used_mb.toLocaleString()} MB of ${gpuStats.mem_total_mb.toLocaleString()} MB`;
  }
}

// ---- Breadcrumb (storage) ------------------------------------------

function renderBreadcrumb(): void {
  const crumb = document.getElementById("storage-crumb");
  if (!crumb) return;
  crumb.replaceChildren();
  for (let i = 0; i < storageStack.length; i++) {
    const level = storageStack[i];
    if (i > 0) {
      crumb.append(el("span", { class: "breadcrumb-sep" }, "›"));
    }
    if (i === storageStack.length - 1) {
      crumb.append(el("span", { class: "breadcrumb-current" }, level.label));
    } else {
      const btn = el("button", {
        class: "breadcrumb-link",
        type: "button",
      }, level.label);
      const targetLevel = i;
      btn.addEventListener("click", () => { popTo(targetLevel); });
      crumb.append(btn);
    }
  }
}

// ---- Tiny DOM helpers -----------------------------------------------

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline SVG icons. Keep here so we don't pull in a 100kB icon
 *  library for the half-dozen glyphs the app needs.
 *
 *  Window controls and the hamburger use the same 12×12 viewBox /
 *  1.2 stroke as desktop-ui's default titlebar glyphs (see
 *  desktop-ui/src/titlebar.ts) so the chrome reads identically
 *  between this shell-style app and canvas apps. Nav icons in the
 *  sidebar use the larger 24×24 / 1.8 Lucide-style geometry. */
function iconSvg(kind: string, cls?: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const small = kind === "minus" || kind === "square" || kind === "x" || kind === "menu";
  svg.setAttribute("viewBox", small ? "0 0 12 12" : "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", small ? "1.2" : "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.classList.add(cls);

  const paths: Record<string, string[]> = {
    // ---- Sidebar nav (24×24, 1.8) ----
    "cpu": [
      "M9 2v3", "M15 2v3", "M9 19v3", "M15 19v3",
      "M2 9h3", "M2 15h3", "M19 9h3", "M19 15h3",
      "M5 5h14v14H5z",
      "M9 9h6v6H9z",
    ],
    "memory": [
      "M3 7h18", "M3 17h18",
      "M3 7v10", "M21 7v10",
      "M7 7v10", "M11 7v10", "M15 7v10", "M19 7v10",
    ],
    "hard-drive": [
      "M22 12H2",
      "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z",
      "M6 16h.01", "M10 16h.01",
    ],
    "container": [
      // Stack of three boxes — reads as "containers" without copying the
      // Docker whale (we stay glyph-neutral, no third-party brand marks).
      "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
      "M3.27 6.96 12 12.01l8.73-5.05",
      "M12 22.08V12",
    ],
    "monitor": [
      "M3 4h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
      "M8 22h8",
      "M12 18v4",
    ],
    // ---- Window-control glyphs (12×12, 1.2) — must match
    // desktop-ui/src/titlebar.ts exactly. ----
    "minus":  ["M2 6h8"],
    "square": ["M2.5 2.5h7v7H2.5z"],
    "x":      ["M3 3l6 6", "M9 3l-6 6"],
    "menu":   ["M2 3h8", "M2 6h8", "M2 9h8"],
    // ---- Row "quit" glyph (24×24, 1.8) — power-symbol style ----
    "x-square": [
      "M4 4h16v16H4z",
      "M9 9l6 6",
      "M15 9l-6 6",
    ],
    "folder": [
      "M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z",
    ],
    "file-text": [
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
      "M14 2v6h6",
      "M8 13h8", "M8 17h8",
    ],
    "external-link": [
      "M15 3h6v6",
      "M10 14L21 3",
      "M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
    ],
  };
  for (const d of paths[kind] ?? []) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// ---- Boot -----------------------------------------------------------

async function boot() {
  const chrome = mountChrome({
    productName: "System Monitor",
    version: __APP_VERSION__,
    layout: "app",
    actions: {},
    showAuxPane: true,
    updater: true,
  });
  auxEl = chrome.aux!;
  auxEl.setAttribute("aria-label", "Views");

  // App layout: desktop-ui provides the main pane's top strip (window
  // controls) + the aux hamburger menu. renderMain swaps the children of
  // the scroll area it hands back.
  mainContentEl = chrome.mainContent!;

  // One-shot capability probe. Decides which sidebar tabs render
  // active vs. muted.
  try {
    caps = await invoke<Capabilities>("capabilities");
  } catch (e) {
    console.warn("capabilities probe failed:", e);
  }

  renderAux();
  renderMain();

  await listen<Snapshot>("tick", (e) => {
    lastSnap = e.payload;
    updateAuxValues();
    renderMain();
  });
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(String(e));
});
