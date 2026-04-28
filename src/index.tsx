import {
  ButtonItem,
  Focusable,
  Navigation,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, routerHook, toaster } from "@decky/api";
import { CSSProperties, ReactNode, useEffect, useMemo, useState } from "react";
import {
  FaBan,
  FaCompress,
  FaEraser,
  FaExpand,
  FaDownload,
  FaPlay,
  FaRedo,
  FaStop,
  FaTasks,
  FaVial,
} from "react-icons/fa";

const ROUTE = "/decky-task-manager";
const POLL_MS = 2000;

type PluginFilter = "all" | "errors" | "running" | "spikes" | "disabled";

type PluginMetrics = {
  name: string;
  cpu: number;
  memory: number;
  processes: number;
  peakCpu: number;
  peakMemory: number;
  spike: boolean;
  spikeReason: string;
};

type PluginRow = {
  folder: string;
  name: string;
  version: string;
  author: string;
  disabled: boolean;
  logs?: LogRow;
  metrics?: PluginMetrics;
};

type LogRow = {
  name: string;
  folder: string;
  errors: number;
  files: number;
  examples: string[];
  groups: {
    message: string;
    count: number;
    file: string;
  }[];
};

type Metrics = {
  timestamp: number;
  cpu: number;
  memory: {
    used: number;
    total: number;
    percent: number;
  };
  plugins: PluginMetrics[];
  history: {
    timestamp: number;
    cpu: number;
    memory: number;
    plugins: Pick<PluginMetrics, "name" | "cpu" | "memory">[];
  }[];
  spike: boolean;
  spikeReason: string;
};

type Snapshot = {
  plugins: PluginRow[];
  logs: {
    plugins: LogRow[];
    totals: {
      errors: number;
      files: number;
    };
  };
  metrics: Metrics;
};

type ActionResult = {
  ok: boolean;
  message: string;
  restarted?: boolean;
  cleared?: number;
  failed?: number;
};

type UpdateStatus = ActionResult & {
  current?: string;
  latest?: string;
  hasUpdate?: boolean;
  assetName?: string;
  releaseUrl?: string;
};

const getSnapshot = callable<[], Snapshot>("get_snapshot");
const getMetrics = callable<[], Metrics>("get_metrics");
const clearLogs = callable<[name?: string], ActionResult>("clear_logs");
const disablePlugin = callable<[name: string], ActionResult>("disable_plugin");
const resetMetrics = callable<[], ActionResult>("reset_metrics");
const checkUpdate = callable<[], UpdateStatus>("check_update");
const installUpdate = callable<[], UpdateStatus>("install_update");

const palette = {
  bg: "rgb(15, 18, 22)",
  panel: "rgba(255, 255, 255, 0.055)",
  panelStrong: "rgba(255, 255, 255, 0.085)",
  border: "rgba(255, 255, 255, 0.12)",
  text: "rgba(255, 255, 255, 0.94)",
  muted: "rgba(255, 255, 255, 0.66)",
  dim: "rgba(255, 255, 255, 0.45)",
  blue: "rgb(69, 137, 255)",
  teal: "rgb(8, 189, 186)",
  red: "rgb(255, 131, 131)",
  yellow: "rgb(241, 194, 27)",
};

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: "28px clamp(18px, 4vw, 44px)",
    background: palette.bg,
    color: palette.text,
    boxSizing: "border-box",
  },
  shell: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 0.9fr) minmax(420px, 1.5fr)",
    gap: "16px",
    maxWidth: "1180px",
    margin: "0 auto",
  },
  qamShell: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  panel: {
    background: palette.panel,
    border: `1px solid ${palette.border}`,
    borderRadius: "8px",
    padding: "14px",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "16px",
    marginBottom: "16px",
  },
  title: {
    fontSize: "26px",
    fontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1.08,
  },
  sectionTitle: {
    fontSize: "13px",
    color: palette.muted,
    textTransform: "uppercase",
    letterSpacing: 0,
    marginBottom: "10px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    width: "100%",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "7px",
    minWidth: 0,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "10px",
  },
  metricCard: {
    background: palette.panelStrong,
    border: `1px solid ${palette.border}`,
    borderRadius: "8px",
    padding: "12px",
    minHeight: "88px",
  },
  hero: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "10px",
    marginBottom: "16px",
    maxWidth: "1180px",
    marginLeft: "auto",
    marginRight: "auto",
  },
  label: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: 1.2,
  },
  value: {
    fontSize: "24px",
    fontWeight: 700,
    lineHeight: 1,
  },
  qamValue: {
    fontSize: "20px",
    fontWeight: 700,
    lineHeight: 1,
  },
  muted: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: 1.3,
  },
  tiny: {
    color: palette.dim,
    fontSize: "11px",
    lineHeight: 1.25,
  },
  meter: {
    height: "7px",
    width: "100%",
    borderRadius: "4px",
    background: "rgba(255, 255, 255, 0.14)",
    overflow: "hidden",
  },
  pluginRow: {
    display: "grid",
    gridTemplateColumns: "minmax(180px, 1.2fr) 96px 96px 86px 104px",
    alignItems: "center",
    gap: "10px",
    padding: "10px 0",
    borderTop: `1px solid ${palette.border}`,
  },
  qamPluginRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 54px 54px 72px",
    alignItems: "center",
    gap: "8px",
    padding: "9px 0",
    borderTop: `1px solid ${palette.border}`,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    width: "fit-content",
    minHeight: "18px",
    borderRadius: "4px",
    padding: "1px 6px",
    fontSize: "11px",
    color: palette.bg,
    background: palette.teal,
  },
  dangerBadge: {
    color: palette.bg,
    background: palette.red,
  },
  warnBadge: {
    color: palette.bg,
    background: palette.yellow,
  },
  examples: {
    marginTop: "8px",
    color: palette.dim,
    fontFamily: "monospace",
    fontSize: "11px",
    lineHeight: 1.28,
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    justifyContent: "flex-end",
  },
  filterBar: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    marginTop: "12px",
  },
};

function Meter({ value, color = palette.blue }: { value: number; color?: string }) {
  return (
    <div style={styles.meter}>
      <div
        style={{
          height: "100%",
          borderRadius: "4px",
          background: color,
          width: `${Math.max(0, Math.min(100, value))}%`,
        }}
      />
    </div>
  );
}

function Badge({ children, tone = "good" }: { children: ReactNode; tone?: "good" | "warn" | "danger" }) {
  const toneStyle = tone === "danger" ? styles.dangerBadge : tone === "warn" ? styles.warnBadge : {};
  return <span style={{ ...styles.badge, ...toneStyle }}>{children}</span>;
}

function EmptyState({ children }: { children: string }) {
  return <div style={{ ...styles.panel, ...styles.muted }}>{children}</div>;
}

function useTaskManager() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [monitoring, setMonitoring] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [selectedPlugin, setSelectedPlugin] = useState<string>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [updating, setUpdating] = useState(false);
  const [testingSince, setTestingSince] = useState<number>();
  const [pendingDisable, setPendingDisable] = useState<string>();

  const refresh = async () => {
    setLoading(true);
    try {
      setSnapshot(await getSnapshot());
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not read Decky status." });
      console.error("[decky-task-manager] refresh failed", error);
    } finally {
      setLoading(false);
    }
  };

  const refreshMetrics = async () => {
    try {
      const metrics = await getMetrics();
      setSnapshot((current) => current ? mergeMetrics(current, metrics) : current);
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not read system metrics." });
      console.error("[decky-task-manager] metrics refresh failed", error);
    }
  };

  const onClearLogs = async (name?: string) => {
    setLoading(true);
    try {
      const result = await clearLogs(name);
      toaster.toast({ title: "Decky Task Manager", body: result.message });
      await refresh();
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not clear logs." });
      console.error("[decky-task-manager] clear logs failed", error);
    } finally {
      setLoading(false);
    }
  };

  const onResetMetrics = async () => {
    try {
      const result = await resetMetrics();
      toaster.toast({ title: "Decky Task Manager", body: result.message });
      await refreshMetrics();
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not reset metric history." });
      console.error("[decky-task-manager] reset metrics failed", error);
    }
  };

  const onStartTest = async () => {
    setLoading(true);
    try {
      await clearLogs();
      await resetMetrics();
      setTestingSince(Date.now());
      setMonitoring(true);
      await refresh();
      toaster.toast({ title: "Decky Task Manager", body: "Testing mode started." });
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not start testing mode." });
      console.error("[decky-task-manager] testing mode failed", error);
    } finally {
      setLoading(false);
    }
  };

  const onDisable = async (name: string) => {
    if (pendingDisable !== name) {
      setPendingDisable(name);
      window.setTimeout(() => {
        setPendingDisable((current) => current === name ? undefined : current);
      }, 4500);
      return;
    }

    setPendingDisable(undefined);
    setBusyPlugin(name);
    try {
      const result = await disablePlugin(name);
      toaster.toast({ title: "Decky Task Manager", body: result.message });

      if (!result.restarted) {
        await refresh();
      }
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: `Could not disable ${name}.` });
      console.error("[decky-task-manager] disable failed", error);
    } finally {
      setBusyPlugin(undefined);
    }
  };

  const onCheckUpdate = async () => {
    setUpdating(true);
    try {
      const result = await checkUpdate();
      setUpdateStatus(result);
      toaster.toast({ title: "Decky Task Manager", body: result.message });
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not check GitHub releases." });
      console.error("[decky-task-manager] update check failed", error);
    } finally {
      setUpdating(false);
    }
  };

  const onInstallUpdate = async () => {
    setUpdating(true);
    try {
      const result = await installUpdate();
      setUpdateStatus(result);
      toaster.toast({ title: "Decky Task Manager", body: result.message });
    } catch (error) {
      toaster.toast({ title: "Decky Task Manager", body: "Could not install update." });
      console.error("[decky-task-manager] update install failed", error);
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!monitoring) return;

    const timer = window.setInterval(refreshMetrics, POLL_MS);
    return () => window.clearInterval(timer);
  }, [monitoring]);

  return {
    snapshot,
    monitoring,
    loading,
    busyPlugin,
    selectedPlugin,
    updateStatus,
    updating,
    testingSince,
    pendingDisable,
    setMonitoring,
    setSelectedPlugin,
    refresh,
    refreshMetrics,
    onClearLogs,
    onResetMetrics,
    onStartTest,
    onDisable,
    onCheckUpdate,
    onInstallUpdate,
  };
}

function mergeMetrics(snapshot: Snapshot, metrics: Metrics): Snapshot {
  const metricMap = new Map(metrics.plugins.map((plugin) => [plugin.name, plugin]));
  return {
    ...snapshot,
    metrics,
    plugins: snapshot.plugins.map((plugin) => ({
      ...plugin,
      metrics: metricMap.get(plugin.name) ?? emptyPluginMetrics(plugin.name),
    })),
  };
}

function emptyPluginMetrics(name: string): PluginMetrics {
  return {
    name,
    cpu: 0,
    memory: 0,
    processes: 0,
    peakCpu: 0,
    peakMemory: 0,
    spike: false,
    spikeReason: "",
  };
}

function Dashboard({ fullscreen = false }: { fullscreen?: boolean }) {
  const state = useTaskManager();
  const [filter, setFilter] = useState<PluginFilter>("all");
  const plugins = useMemo(() => state.snapshot?.plugins ?? [], [state.snapshot]);
  const noisyLogs = useMemo(
    () => state.snapshot?.logs.plugins.filter((plugin) => plugin.errors > 0).slice(0, fullscreen ? 12 : 4) ?? [],
    [state.snapshot, fullscreen],
  );
  const activePlugins = useMemo(
    () => plugins
      .map((plugin) => ({ ...plugin, metrics: plugin.metrics ?? emptyPluginMetrics(plugin.name) }))
      .sort((a, b) => (b.metrics?.cpu ?? 0) - (a.metrics?.cpu ?? 0) || (b.metrics?.memory ?? 0) - (a.metrics?.memory ?? 0)),
    [plugins],
  );
  const filteredPlugins = useMemo(
    () => activePlugins.filter((plugin) => matchesFilter(plugin, filter)),
    [activePlugins, filter],
  );
  const selectedLog = useMemo(
    () => state.snapshot?.logs.plugins.find((plugin) => plugin.name === state.selectedPlugin),
    [state.snapshot, state.selectedPlugin],
  );
  const top = useMemo(() => topSummary(state.snapshot), [state.snapshot]);

  if (fullscreen) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <div style={styles.stack}>
            <div style={styles.title}>Decky Task Manager</div>
            <div style={styles.muted}>
              Live while this page is open. Clear logs, start a fresh watch, then trigger the thing you want to test.
              {state.testingSince ? ` Testing since ${formatTime(state.testingSince)}.` : ""}
            </div>
          </div>
          <div style={styles.actions}>
            <ButtonItem layout="below" onClick={() => Navigation.NavigateBack()}>
              <FaCompress /> Close
            </ButtonItem>
            <MonitorButton monitoring={state.monitoring} onClick={() => state.setMonitoring(!state.monitoring)} />
            <ButtonItem layout="below" disabled={state.loading} onClick={state.refresh}>
              <FaRedo /> Refetch
            </ButtonItem>
            <ButtonItem layout="below" disabled={state.loading} onClick={() => state.onClearLogs()}>
              <FaEraser /> Clear Logs
            </ButtonItem>
            <ButtonItem layout="below" disabled={state.loading} onClick={state.onStartTest}>
              <FaVial /> Test Mode
            </ButtonItem>
            <ButtonItem layout="below" onClick={state.onResetMetrics}>
              Reset Peaks
            </ButtonItem>
            <ButtonItem layout="below" disabled={state.updating} onClick={state.onCheckUpdate}>
              <FaDownload /> Check Update
            </ButtonItem>
            <ButtonItem
              layout="below"
              disabled={state.updating || !state.updateStatus?.hasUpdate}
              onClick={state.onInstallUpdate}
            >
              <FaDownload /> Install
            </ButtonItem>
          </div>
        </div>

        <div style={styles.hero}>
          <MetricCard label="top errors" value={top.errors.value} detail={top.errors.label} tone={top.errors.danger ? "danger" : "good"} />
          <MetricCard label="top cpu" value={top.cpu.value} detail={top.cpu.label} tone={top.cpu.danger ? "danger" : "good"} />
          <MetricCard label="top ram" value={top.memory.value} detail={top.memory.label} />
          <MetricCard label="last updated" value={formatTime(state.snapshot?.metrics.timestamp)} detail={state.monitoring ? "live watch" : "paused"} />
        </div>

        <div style={styles.shell}>
          <div style={styles.stack}>
            <SystemPanel snapshot={state.snapshot} monitoring={state.monitoring} />
            <UpdatePanel
              status={state.updateStatus}
              updating={state.updating}
              onCheckUpdate={state.onCheckUpdate}
              onInstallUpdate={state.onInstallUpdate}
            />
            <LogsPanel
              rows={noisyLogs}
              snapshot={state.snapshot}
              selectedLog={selectedLog}
              onSelectPlugin={state.setSelectedPlugin}
              onClearLogs={state.onClearLogs}
            />
          </div>
          <PluginTable
            plugins={filteredPlugins}
            filter={filter}
            onFilter={setFilter}
            busyPlugin={state.busyPlugin}
            pendingDisable={state.pendingDisable}
            onDisable={state.onDisable}
            onSelectPlugin={state.setSelectedPlugin}
            selectedPlugin={state.selectedPlugin}
            fullscreen
          />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.qamShell}>
      <PanelSection title="Monitor">
        <PanelSectionRow>
          <div style={styles.row}>
            <div style={styles.stack}>
              <div style={styles.qamValue}>{state.snapshot?.metrics.cpu ?? "-"}% CPU</div>
              <div style={styles.muted}>
                {state.snapshot?.metrics.memory.percent ?? "-"}% RAM
                {state.snapshot?.metrics.spike ? ` · spike: ${state.snapshot.metrics.spikeReason}` : ""}
                {state.snapshot?.metrics.timestamp ? ` · ${formatTime(state.snapshot.metrics.timestamp)}` : ""}
              </div>
            </div>
            <MonitorButton monitoring={state.monitoring} onClick={() => state.setMonitoring(!state.monitoring)} />
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={styles.row}>
            <ButtonItem layout="below" onClick={openFullscreen}>
              <FaExpand /> Fullscreen
            </ButtonItem>
            <ButtonItem layout="below" disabled={state.loading} onClick={state.onStartTest}>
              <FaVial /> Test
            </ButtonItem>
            <ButtonItem layout="below" disabled={state.loading} onClick={state.refresh}>
              <FaRedo /> Refetch
            </ButtonItem>
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={styles.row}>
            <div style={styles.stack}>
              <span>GitHub update</span>
              <span style={styles.muted}>
                {state.updateStatus?.hasUpdate
                  ? `${state.updateStatus.latest} available`
                  : state.updateStatus?.message ?? "manual check"}
              </span>
            </div>
            <ButtonItem layout="below" disabled={state.updating} onClick={state.onCheckUpdate}>
              Check
            </ButtonItem>
          </div>
        </PanelSectionRow>
        {state.updateStatus?.hasUpdate && (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={state.updating} onClick={state.onInstallUpdate}>
              <FaDownload /> Install {state.updateStatus.latest}
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Plugin Errors">
        <PanelSectionRow>
          <div style={styles.row}>
            <div style={styles.stack}>
              <div style={styles.qamValue}>{state.snapshot?.logs.totals.errors ?? "-"}</div>
              <div style={styles.muted}>errors across {state.snapshot?.logs.totals.files ?? 0} log files</div>
            </div>
            <ButtonItem layout="below" disabled={state.loading} onClick={() => state.onClearLogs()}>
              <FaEraser /> Clear
            </ButtonItem>
          </div>
        </PanelSectionRow>
        {noisyLogs.length === 0 && (
          <PanelSectionRow>
            <div style={styles.muted}>No plugin log errors found.</div>
          </PanelSectionRow>
        )}
        {noisyLogs.map((plugin) => (
          <PanelSectionRow key={plugin.name}>
            <div style={styles.qamPluginRow}>
              <div style={styles.stack}>
                <span>{plugin.name}</span>
                <span style={styles.tiny}>{plugin.files} files</span>
              </div>
              <span>{plugin.errors}</span>
              <span style={styles.tiny}>errors</span>
              <ButtonItem layout="below" onClick={() => state.onClearLogs(plugin.name)}>
                Clear
              </ButtonItem>
            </div>
          </PanelSectionRow>
        ))}
      </PanelSection>

      <PanelSection title="Plugin Load">
        {activePlugins.slice(0, 6).map((plugin) => (
          <PanelSectionRow key={plugin.name}>
            <PluginQamRow
              plugin={plugin}
              busyPlugin={state.busyPlugin}
              pendingDisable={state.pendingDisable}
              onDisable={state.onDisable}
            />
          </PanelSectionRow>
        ))}
      </PanelSection>
    </div>
  );
}

function MonitorButton({ monitoring, onClick }: { monitoring: boolean; onClick(): void }) {
  return (
    <ButtonItem layout="below" onClick={onClick}>
      {monitoring ? <FaStop /> : <FaPlay />} {monitoring ? "Stop" : "Start"}
    </ButtonItem>
  );
}

function SystemPanel({ snapshot, monitoring }: { snapshot?: Snapshot; monitoring: boolean }) {
  const metrics = snapshot?.metrics;
  const activeCount = metrics?.plugins.filter((plugin) => plugin.processes > 0).length ?? 0;

  return (
    <div style={styles.panel}>
      <div style={styles.sectionTitle}>System</div>
      <div style={styles.grid}>
        <MetricCard label="CPU" value={`${metrics?.cpu ?? "-"}%`} tone={metrics?.cpu && metrics.cpu > 85 ? "danger" : "good"} />
        <MetricCard label="RAM" value={`${metrics?.memory.percent ?? "-"}%`} detail={`${metrics?.memory.used ?? "-"} / ${metrics?.memory.total ?? "-"} MB`} />
        <MetricCard
          label="Watch"
          value={monitoring ? "live" : "paused"}
          detail={`${activeCount} active plugin${activeCount === 1 ? "" : "s"} · ${formatTime(metrics?.timestamp)}`}
        />
      </div>
      <div style={{ marginTop: "14px" }}>
        <div style={styles.row}>
          <span style={styles.label}>cpu</span>
          <span>{metrics?.cpu ?? "-"}%</span>
        </div>
        <Meter value={metrics?.cpu ?? 0} color={metrics?.spike ? palette.red : palette.blue} />
      </div>
      <div style={{ marginTop: "10px" }}>
        <div style={styles.row}>
          <span style={styles.label}>ram</span>
          <span>{metrics?.memory.percent ?? "-"}%</span>
        </div>
        <Meter value={metrics?.memory.percent ?? 0} color={palette.teal} />
      </div>
      {metrics?.spike && (
        <div style={{ marginTop: "10px" }}>
          <Badge tone="danger">spike: {metrics.spikeReason}</Badge>
        </div>
      )}
    </div>
  );
}

function UpdatePanel({
  status,
  updating,
  onCheckUpdate,
  onInstallUpdate,
}: {
  status?: UpdateStatus;
  updating: boolean;
  onCheckUpdate(): void;
  onInstallUpdate(): void;
}) {
  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <div style={styles.stack}>
          <div style={styles.sectionTitle}>Updates</div>
          <div style={styles.value}>
            {status?.hasUpdate ? `${status.latest} ready` : status?.current ? `v${status.current}` : "GitHub"}
          </div>
          <div style={styles.muted}>
            {status?.message ?? "Checks the latest GitHub release and installs the Decky zip."}
          </div>
        </div>
        <div style={styles.actions}>
          <ButtonItem layout="below" disabled={updating} onClick={onCheckUpdate}>
            <FaDownload /> Check
          </ButtonItem>
          <ButtonItem layout="below" disabled={updating || !status?.hasUpdate} onClick={onInstallUpdate}>
            Install
          </ButtonItem>
        </div>
      </div>
      {status?.assetName && <div style={{ ...styles.tiny, marginTop: "8px" }}>{status.assetName}</div>}
    </div>
  );
}

function MetricCard({ label, value, detail, tone = "good" }: { label: string; value: string; detail?: string; tone?: "good" | "danger" }) {
  return (
    <div style={styles.metricCard}>
      <div style={styles.label}>{label}</div>
      <div style={{ ...styles.value, color: tone === "danger" ? palette.red : palette.text }}>{value}</div>
      {detail && <div style={styles.tiny}>{detail}</div>}
    </div>
  );
}

function LogsPanel({
  rows,
  snapshot,
  selectedLog,
  onSelectPlugin,
  onClearLogs,
}: {
  rows: LogRow[];
  snapshot?: Snapshot;
  selectedLog?: LogRow;
  onSelectPlugin(name?: string): void;
  onClearLogs(name?: string): void;
}) {
  const detail = selectedLog && selectedLog.errors > 0 ? selectedLog : undefined;

  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <div>
          <div style={styles.sectionTitle}>Plugin Errors</div>
          <div style={styles.value}>{snapshot?.logs.totals.errors ?? "-"} errors</div>
          <div style={styles.muted}>from {snapshot?.logs.totals.files ?? 0} scanned log files</div>
        </div>
        <ButtonItem layout="below" onClick={() => onClearLogs()}>
          <FaEraser /> Clear All
        </ButtonItem>
      </div>

      {detail && (
        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: `1px solid ${palette.border}` }}>
          <div style={styles.row}>
            <div style={styles.stack}>
              <span>{detail.name}</span>
              <span style={styles.muted}>{detail.errors} grouped into {detail.groups.length} row{detail.groups.length === 1 ? "" : "s"}</span>
            </div>
            <ButtonItem layout="below" onClick={() => onSelectPlugin(undefined)}>
              Hide
            </ButtonItem>
          </div>
          {detail.groups.slice(0, 10).map((group, index) => (
            <div key={`${detail.name}-${index}`} style={{ paddingTop: "10px" }}>
              <div style={styles.row}>
                <Badge tone={group.count > 5 ? "danger" : "warn"}>{group.count}x</Badge>
                <span style={styles.tiny}>{group.file}</span>
              </div>
              <div style={styles.examples}>{group.message}</div>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 && <EmptyState>No plugin log errors found.</EmptyState>}

      {rows.map((plugin) => (
        <div key={plugin.name} style={{ paddingTop: "12px", borderTop: `1px solid ${palette.border}`, marginTop: "12px" }}>
          <div style={styles.row}>
            <div style={styles.stack}>
              <span>{plugin.name}</span>
              <span style={styles.muted}>{plugin.files} log file{plugin.files === 1 ? "" : "s"}</span>
            </div>
            <div style={styles.actions}>
              <Badge tone={plugin.errors > 10 ? "danger" : "warn"}>{plugin.errors} errors</Badge>
              <ButtonItem layout="below" onClick={() => onSelectPlugin(plugin.name)}>
                View
              </ButtonItem>
              <ButtonItem layout="below" onClick={() => onClearLogs(plugin.name)}>
                Clear
              </ButtonItem>
            </div>
          </div>
          {plugin.examples.slice(0, 2).map((example, index) => (
            <div style={styles.examples} key={`${plugin.name}-${index}`}>{example}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function PluginTable({
  plugins,
  filter,
  onFilter,
  busyPlugin,
  pendingDisable,
  onDisable,
  onSelectPlugin,
  selectedPlugin,
  fullscreen = false,
}: {
  plugins: PluginRow[];
  filter: PluginFilter;
  onFilter(filter: PluginFilter): void;
  busyPlugin?: string;
  pendingDisable?: string;
  onDisable(name: string): void;
  onSelectPlugin?(name: string): void;
  selectedPlugin?: string;
  fullscreen?: boolean;
}) {
  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <div>
          <div style={styles.sectionTitle}>Plugins</div>
          <div style={styles.value}>{plugins.length} installed</div>
        </div>
        <Badge>{plugins.filter((plugin) => plugin.metrics?.processes).length} active</Badge>
      </div>

      <div style={styles.filterBar}>
        {(["all", "errors", "running", "spikes", "disabled"] as PluginFilter[]).map((item) => (
          <ButtonItem key={item} layout="below" onClick={() => onFilter(item)}>
            {filter === item ? "Show " : ""}{item}
          </ButtonItem>
        ))}
      </div>

      <div style={{ ...styles.pluginRow, color: palette.muted, fontSize: "12px", paddingTop: "16px" }}>
        <span>name</span>
        <span>cpu</span>
        <span>ram</span>
        <span>state</span>
        <span>action</span>
      </div>

      {plugins.map((plugin) => {
        const metrics = plugin.metrics ?? emptyPluginMetrics(plugin.name);
        const isSelected = selectedPlugin === plugin.name;
        return (
          <Focusable
            style={{
              ...styles.pluginRow,
              background: isSelected ? "rgba(69, 137, 255, 0.12)" : "transparent",
            }}
            key={plugin.name}
            onActivate={() => onSelectPlugin?.(plugin.name)}
          >
            <div style={styles.stack}>
              <span>{plugin.name}</span>
              <span style={styles.tiny}>
                {plugin.version ? `v${plugin.version}` : plugin.folder}
                {metrics.processes ? ` · ${metrics.processes} process${metrics.processes === 1 ? "" : "es"}` : " · idle"}
              </span>
              {fullscreen && metrics.spike && <Badge tone="danger">spike: {metrics.spikeReason}</Badge>}
            </div>
            <MetricCell value={metrics.cpu} suffix="%" spike={metrics.spike && metrics.spikeReason === "cpu"} />
            <MetricCell value={metrics.memory} suffix=" MB" spike={metrics.spike && metrics.spikeReason === "ram"} />
            <span style={styles.muted}>{plugin.disabled ? "disabled" : metrics.processes ? "running" : "idle"}</span>
            <ButtonItem
              layout="below"
              disabled={plugin.disabled || busyPlugin === plugin.name}
              onClick={() => onDisable(plugin.name)}
            >
              <FaBan /> {plugin.disabled ? "Disabled" : busyPlugin === plugin.name ? "Disabling" : pendingDisable === plugin.name ? "Sure?" : "Disable"}
            </ButtonItem>
          </Focusable>
        );
      })}
    </div>
  );
}

function PluginQamRow({
  plugin,
  busyPlugin,
  pendingDisable,
  onDisable,
}: {
  plugin: PluginRow;
  busyPlugin?: string;
  pendingDisable?: string;
  onDisable(name: string): void;
}) {
  const metrics = plugin.metrics ?? emptyPluginMetrics(plugin.name);
  return (
    <div style={styles.qamPluginRow}>
      <div style={styles.stack}>
        <span>{plugin.name}</span>
        <span style={styles.tiny}>{plugin.disabled ? "disabled" : metrics.processes ? "running" : "idle"}</span>
      </div>
      <MetricCell value={metrics.cpu} suffix="%" spike={metrics.spike && metrics.spikeReason === "cpu"} />
      <MetricCell value={metrics.memory} suffix=" MB" spike={metrics.spike && metrics.spikeReason === "ram"} />
      <ButtonItem
        layout="below"
        disabled={plugin.disabled || busyPlugin === plugin.name}
        onClick={() => onDisable(plugin.name)}
      >
        {pendingDisable === plugin.name ? "Sure?" : "Disable"}
      </ButtonItem>
    </div>
  );
}

function matchesFilter(plugin: PluginRow, filter: PluginFilter) {
  const metrics = plugin.metrics ?? emptyPluginMetrics(plugin.name);
  const errors = plugin.logs?.errors ?? 0;

  switch (filter) {
    case "errors":
      return errors > 0;
    case "running":
      return metrics.processes > 0;
    case "spikes":
      return metrics.spike;
    case "disabled":
      return plugin.disabled;
    default:
      return true;
  }
}

function topSummary(snapshot?: Snapshot) {
  const plugins = snapshot?.plugins ?? [];
  const errors = [...plugins].sort((a, b) => (b.logs?.errors ?? 0) - (a.logs?.errors ?? 0))[0];
  const cpu = [...plugins].sort((a, b) => (b.metrics?.cpu ?? 0) - (a.metrics?.cpu ?? 0))[0];
  const memory = [...plugins].sort((a, b) => (b.metrics?.memory ?? 0) - (a.metrics?.memory ?? 0))[0];

  return {
    errors: {
      value: `${errors?.logs?.errors ?? 0}`,
      label: errors?.name ?? "no plugins",
      danger: (errors?.logs?.errors ?? 0) > 0,
    },
    cpu: {
      value: `${cpu?.metrics?.cpu ?? 0}%`,
      label: cpu?.name ?? "no plugins",
      danger: (cpu?.metrics?.spike ?? false),
    },
    memory: {
      value: `${memory?.metrics?.memory ?? 0} MB`,
      label: memory?.name ?? "no plugins",
    },
  };
}

function formatTime(value?: number) {
  if (!value) return "-";
  return new Date(value * (value < 10_000_000_000 ? 1000 : 1)).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function MetricCell({ value, suffix, spike }: { value: number; suffix: string; spike?: boolean }) {
  return (
    <span style={{ color: spike ? palette.red : palette.text, fontVariantNumeric: "tabular-nums" }}>
      {value}{suffix}
    </span>
  );
}

function openFullscreen() {
  Navigation.Navigate(ROUTE);
  Navigation.CloseSideMenus();
}

function FullscreenRoute() {
  return <Dashboard fullscreen />;
}

export default definePlugin(() => {
  routerHook.addRoute(ROUTE, FullscreenRoute, { exact: true });

  return {
    name: "Decky Task Manager",
    titleView: <div className={staticClasses.Title}>Decky Task Manager</div>,
    content: <Dashboard />,
    icon: <FaTasks />,
    onDismount() {
      routerHook.removeRoute(ROUTE);
    },
  };
});
