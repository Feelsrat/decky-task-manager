export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type PluginMetrics = {
  name: string;
  cpu: number;
  memory: number;
  peakCpu: number;
  peakMemory: number;
  processes: number;
  spike: boolean;
  spikeReason: string;
};

export type KnownIssue = {
  id: string;
  severity: Severity;
  title: string;
  advice: string;
  count: number;
  files: string[];
  examples: string[];
};

export type LogAlert = {
  id: string;
  severity: Severity;
  title: string;
  message: string;
};

export type LogRate = {
  bytesPerSecond: number;
  linesPerSecond: number;
  errorsPerSecond: number;
  active: boolean;
};

export type ErrorGroup = {
  message: string;
  count: number;
  file: string;
};

export type PluginLogs = {
  name?: string;
  folder?: string;
  errors: number;
  files?: number;
  examples: string[];
  groups?: ErrorGroup[];
  knownIssues?: KnownIssue[];
  alerts?: LogAlert[];
  rate?: LogRate;
  severity?: Severity;
  serious?: boolean;
};

export type PluginRow = {
  folder: string;
  name: string;
  version: string;
  author?: string;
  disabled: boolean;
  logs?: PluginLogs;
  metrics?: PluginMetrics;
};

export type LogTotals = {
  errors: number;
  files?: number;
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  alerts?: number;
  serious?: number;
  noisyPlugins?: number;
};

export type HistoryPoint = {
  timestamp: number;
  cpu: number;
  memory: number;
  plugins: { name: string; cpu: number; memory: number }[];
};

export type Metrics = {
  timestamp?: number;
  cpu: number;
  memory: { used: number; total: number; percent: number };
  plugins: PluginMetrics[];
  history?: HistoryPoint[];
  spike?: boolean;
  spikeReason?: string;
};

export type Logs = {
  plugins: PluginLogs[];
  totals: LogTotals;
};

export type Snapshot = {
  plugins: PluginRow[];
  logs: Logs;
  metrics: Metrics;
};

export type ActionResult = { ok: boolean; message: string };

export type UpdateStatus = ActionResult & {
  current?: string;
  latest?: string;
  elevated?: boolean;
  hasUpdate?: boolean;
  canInstall?: boolean;
  installedVersion?: string;
  requiresRestart?: boolean;
  restarted?: boolean;
};

export type MonitoringState = {
  enabled: boolean;
  metrics?: Metrics | null;
  logs?: Logs | null;
  pollIntervalMs?: number;
};

export type Tab = "overview" | "plugins" | "logs";
