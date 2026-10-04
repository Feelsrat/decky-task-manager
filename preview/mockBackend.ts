/**
 * In-browser stand-in for main.py. Returns the same shapes as the Python backend so the UI can
 * be exercised without a Steam Deck. Pick a scenario with ?scenario=healthy|issues|busy|empty.
 */
import type { HistoryPoint, KnownIssue, LogAlert, Metrics, PluginLogs, Severity } from "../src/types";

type MockPlugin = {
  folder: string;
  name: string;
  version: string;
  author: string;
  baseCpu: number; // 0 = no backend process
  baseMemory: number;
  processes: number;
  errors?: number;
  severity?: Severity;
  issues?: Omit<KnownIssue, "files" | "examples">[];
  alerts?: LogAlert[];
  lines?: string[];
  noisy?: boolean;
  spike?: "cpu" | "ram";
};

const SELF: MockPlugin = {
  folder: "decky-task-manager",
  name: "Decky Task Manager",
  version: "0.1.20",
  author: "yuri",
  baseCpu: 0.8,
  baseMemory: 38,
  processes: 1,
};

const HEALTHY: MockPlugin[] = [
  SELF,
  { folder: "SDH-CssLoader", name: "CSS Loader", version: "2.1.2", author: "SuchMeme", baseCpu: 0.4, baseMemory: 52, processes: 1 },
  { folder: "decky-steamgriddb", name: "SteamGridDB", version: "1.6.0", author: "SteamGridDB", baseCpu: 0, baseMemory: 0, processes: 0 },
  { folder: "PowerTools", name: "PowerTools", version: "2.0.3", author: "NGnius", baseCpu: 1.6, baseMemory: 24, processes: 1 },
  { folder: "protondb-decky", name: "ProtonDB Badges", version: "1.2.0", author: "OMGDuke", baseCpu: 0, baseMemory: 0, processes: 0 },
  { folder: "tabmaster", name: "TabMaster", version: "2.7.1", author: "Tormak", baseCpu: 0, baseMemory: 0, processes: 0 },
];

const ISSUES: MockPlugin[] = [
  SELF,
  {
    folder: "SDH-AudioLoader",
    name: "Audio Loader",
    version: "1.6.1",
    author: "EMERALD",
    baseCpu: 23,
    baseMemory: 186,
    processes: 2,
    spike: "cpu",
    errors: 342,
    severity: "critical",
    issues: [
      { id: "traceback", severity: "critical", title: "Python crash traceback", advice: "The plugin backend threw an unhandled exception.", count: 38 },
      { id: "missing_dependency", severity: "high", title: "Missing dependency", advice: "A required Python or JavaScript dependency is missing.", count: 12 },
    ],
    alerts: [{ id: "error_spam", severity: "high", title: "Log errors are repeating", message: "3.2 errors/sec" }],
    lines: [
      "[Audio Loader] ERROR Traceback (most recent call last): File \"/home/deck/homebrew/plugins/SDH-AudioLoader/main.py\", line 88, in _load_packs",
      "[Audio Loader] ERROR ModuleNotFoundError: No module named 'pygame'",
      "[Audio Loader] ERROR failed to play sound pack 'Deck Startup': file not found",
    ],
    noisy: true,
  },
  { folder: "SDH-CssLoader", name: "CSS Loader", version: "2.1.2", author: "SuchMeme", baseCpu: 0.6, baseMemory: 61, processes: 1 },
  {
    folder: "decky-steamgriddb",
    name: "SteamGridDB",
    version: "1.6.0",
    author: "SteamGridDB",
    baseCpu: 0,
    baseMemory: 0,
    processes: 0,
    errors: 14,
    severity: "medium",
    issues: [{ id: "network", severity: "medium", title: "Network/API failure", advice: "The plugin is failing an external request.", count: 14 }],
    lines: ["[SteamGridDB] ERROR request failed: HTTP 503 from www.steamgriddb.com/api/v2/grids/game/1145360"],
  },
  { folder: "PowerTools", name: "PowerTools", version: "2.0.3", author: "NGnius", baseCpu: 2.1, baseMemory: 412, processes: 1, spike: "ram" },
  {
    folder: "protondb-decky",
    name: "ProtonDB Badges",
    version: "1.2.0",
    author: "OMGDuke",
    baseCpu: 0,
    baseMemory: 0,
    processes: 0,
    errors: 3,
    severity: "low",
    lines: ["[ProtonDB Badges] WARNING failed to fetch summary for app 2050650, retrying"],
  },
  { folder: "tabmaster", name: "TabMaster", version: "2.7.1", author: "Tormak", baseCpu: 0, baseMemory: 0, processes: 0 },
  { folder: "decky-recorder", name: "Decky Recorder", version: "3.1.0", author: "Marios", baseCpu: 0, baseMemory: 0, processes: 0 },
  { folder: "MagicPods", name: "MagicPods", version: "0.9.4", author: "Ruslan", baseCpu: 0.3, baseMemory: 33, processes: 1 },
];

const BUSY: MockPlugin[] = [
  ...HEALTHY,
  { folder: "decky-recorder", name: "Decky Recorder", version: "3.1.0", author: "Marios", baseCpu: 34, baseMemory: 520, processes: 3, spike: "cpu" },
  { folder: "MagicPods", name: "MagicPods", version: "0.9.4", author: "Ruslan", baseCpu: 4.2, baseMemory: 88, processes: 1 },
  { folder: "decky-autoflatpaks", name: "Auto Flatpaks", version: "1.0.4", author: "jessebofill", baseCpu: 2.4, baseMemory: 41, processes: 1 },
];

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "issues";
const SCENARIOS: Record<string, { plugins: MockPlugin[]; systemCpu: number; ramPercent: number; monitoring: boolean }> = {
  healthy: { plugins: HEALTHY, systemCpu: 18, ramPercent: 46, monitoring: false },
  issues: { plugins: ISSUES, systemCpu: 41, ramPercent: 63, monitoring: true },
  busy: { plugins: BUSY, systemCpu: 91, ramPercent: 87, monitoring: true },
  empty: { plugins: [SELF], systemCpu: 9, ramPercent: 38, monitoring: false },
};
const config = SCENARIOS[scenario] || SCENARIOS.issues;

const TOTAL_MB = 15_602; // 16 GB Deck
const plugins = config.plugins.map((p) => ({ ...p }));
const disabled = new Set<string>(scenario === "issues" ? ["Decky Recorder"] : []);
const cleared = new Set<string>();
const peaks = new Map<string, { cpu: number; memory: number }>();
let history: HistoryPoint[] = [];
let monitoring = params.has("monitoring") ? params.get("monitoring") === "1" : config.monitoring;
let latestMetrics: Metrics | null = null;
let t = 0;

const wobble = (base: number, spread: number) => Math.max(0, base + (Math.sin(t * 1.7 + base) + Math.sin(t * 0.6)) * spread);

function isRunning(p: MockPlugin) {
  return p.baseCpu > 0 && !disabled.has(p.name);
}

function sampleMetrics(): Metrics {
  t += 1;
  const pluginMetrics = plugins.filter(isRunning).map((p) => {
    const cpu = Math.round(wobble(p.baseCpu, p.baseCpu * 0.35) * 10) / 10;
    const memory = Math.round(wobble(p.baseMemory, p.baseMemory * 0.03));
    const peak = peaks.get(p.name) || { cpu: 0, memory: 0 };
    const peakCpu = Math.max(peak.cpu, cpu, p.spike === "cpu" ? p.baseCpu * 1.9 : 0);
    const peakMemory = Math.max(peak.memory, memory, p.spike === "ram" ? p.baseMemory * 1.4 : 0);
    peaks.set(p.name, { cpu: peakCpu, memory: peakMemory });
    return {
      name: p.name,
      cpu,
      memory,
      processes: p.processes,
      peakCpu: Math.round(peakCpu * 10) / 10,
      peakMemory: Math.round(peakMemory),
      spike: !!p.spike,
      spikeReason: p.spike || "",
    };
  });

  const cpu = Math.min(100, Math.round(wobble(config.systemCpu, 6) * 10) / 10);
  const percent = Math.round(wobble(config.ramPercent, 1.2) * 10) / 10;

  if (history.length === 0) {
    // Seed some history so the sparklines have something to draw
    for (let i = 30; i > 0; i--) {
      t += 1;
      history.push({
        timestamp: Date.now() / 1000 - i,
        cpu: Math.min(100, Math.round(wobble(config.systemCpu, 9) * 10) / 10),
        memory: Math.round(wobble(config.ramPercent, 1.5) * 10) / 10,
        plugins: [],
      });
    }
  }
  history = [
    ...history,
    { timestamp: Date.now() / 1000, cpu, memory: percent, plugins: pluginMetrics.map(({ name, cpu, memory }) => ({ name, cpu, memory })) },
  ].slice(-60);

  latestMetrics = {
    timestamp: Date.now() / 1000,
    cpu,
    memory: { used: Math.round((TOTAL_MB * percent) / 100), total: TOTAL_MB, percent },
    plugins: pluginMetrics,
    history,
  };
  return latestMetrics;
}

function scanLogs() {
  const totals = { errors: 0, files: 0, critical: 0, high: 0, medium: 0, low: 0, alerts: 0, serious: 0, noisyPlugins: 0 };
  const rows: PluginLogs[] = plugins.map((p) => {
    const hasLog = !cleared.has(p.name);
    const errors = hasLog ? p.errors || 0 : 0;
    const severity: Severity = errors ? p.severity || "low" : "info";
    const knownIssues = hasLog
      ? (p.issues || []).map((issue) => ({ ...issue, files: [`${p.folder}/2026-10-04.log`], examples: [] }))
      : [];
    const alerts = hasLog ? p.alerts || [] : [];
    const serious = severity === "high" || severity === "critical";
    totals.errors += errors;
    totals.files += hasLog ? 1 : 0;
    if (severity !== "info") totals[severity] += 1;
    if (serious) totals.serious += 1;
    totals.alerts += alerts.length;
    if (hasLog && p.noisy) totals.noisyPlugins += 1;
    const lines = hasLog ? p.lines || [] : [];
    return {
      name: p.name,
      folder: p.folder,
      errors,
      files: hasLog ? 1 : 0,
      examples: lines,
      groups: lines.map((message, i) => ({ message, count: Math.max(1, Math.round(errors / (i + 2))), file: `${p.folder}/2026-10-04.log` })),
      knownIssues,
      alerts,
      rate: {
        bytesPerSecond: hasLog && p.noisy ? 6250 : 0,
        linesPerSecond: hasLog && p.noisy ? 14.2 : 0,
        errorsPerSecond: hasLog && p.noisy ? 3.2 : 0,
        active: hasLog && !!p.noisy,
      },
      severity,
      serious,
    };
  });
  rows.sort((a, b) => b.errors - a.errors || a.name!.localeCompare(b.name!));
  return { plugins: rows, totals };
}

function listPlugins() {
  return [...plugins]
    .sort((a, b) => a.folder.toLowerCase().localeCompare(b.folder.toLowerCase()))
    .map((p) => ({ folder: p.folder, name: p.name, version: p.version, author: p.author, disabled: disabled.has(p.name) }));
}

let monitorTimer: number | undefined;
function syncMonitorLoop() {
  window.clearInterval(monitorTimer);
  if (monitoring) monitorTimer = window.setInterval(sampleMetrics, 1000);
}
syncMonitorLoop();

export const backend = {
  get_snapshot() {
    const logs = scanLogs();
    const metrics = sampleMetrics();
    return {
      // Like main.py: plugins without a log row or process get {} rather than nothing
      plugins: listPlugins().map((p) => ({
        ...p,
        logs: logs.plugins.find((row) => row.name === p.name) || {},
        metrics: metrics.plugins.find((row) => row.name === p.name) || {},
      })),
      logs,
      metrics,
    };
  },
  get_metrics: () => sampleMetrics(),
  get_monitoring_state: () => ({ enabled: monitoring, metrics: latestMetrics, logs: scanLogs(), pollIntervalMs: 1000 }),
  set_monitoring(enabled: boolean) {
    monitoring = enabled;
    if (enabled) sampleMetrics();
    syncMonitorLoop();
    return backend.get_monitoring_state();
  },
  reset_metrics() {
    peaks.clear();
    history = [];
    plugins.forEach((p) => (p.spike = undefined));
    return { ok: true, message: "Reset metric history." };
  },
  clear_logs(name?: string) {
    const targets = name ? [name] : plugins.map((p) => p.name);
    targets.forEach((n) => cleared.add(n));
    return { ok: true, cleared: targets.length, failed: 0, message: `Cleared ${targets.length} log file${targets.length === 1 ? "" : "s"}.` };
  },
  disable_plugin(name: string) {
    if (name === SELF.name) return { ok: false, message: "Decky Task Manager cannot disable itself." };
    disabled.add(name);
    return { ok: true, message: `${name} is disabled.`, restarted: true };
  },
  enable_plugin(name: string) {
    disabled.delete(name);
    return { ok: true, message: `${name} is enabled.`, restarted: true };
  },
  kill_plugin_processes(name: string) {
    const plugin = plugins.find((p) => p.name === name);
    const count = plugin?.processes || 0;
    if (plugin) plugin.baseCpu = 0;
    return { ok: true, terminated: [], killed: [], failed: [], message: `Sent kill signal to ${count} ${name} process${count === 1 ? "" : "es"}.` };
  },
  get_update_status: () => ({ ok: true, current: SELF.version, elevated: true, hasUpdate: false, canInstall: false, message: "Ready to check for updates." }),
  check_update: () =>
    scenario === "healthy"
      ? { ok: true, current: SELF.version, latest: "0.1.21", elevated: true, hasUpdate: true, canInstall: true, message: "Update available." }
      : { ok: true, current: SELF.version, latest: SELF.version, elevated: true, hasUpdate: false, canInstall: true, message: "Latest release is already installed." },
  install_update: () => ({ ok: true, current: "0.1.21", latest: "0.1.21", hasUpdate: false, canInstall: true, requiresRestart: true, message: "Installed 0.1.21. Decky restart scheduled." }),
};
