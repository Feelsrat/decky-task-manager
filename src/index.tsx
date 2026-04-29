import {
  ButtonItem,
  Field,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState, FC, ReactNode } from "react";
import {
  FaBan,
  FaCheck,
  FaEraser,
  FaDownload,
  FaTasks,
  FaVial,
  FaMicrochip,
  FaMemory,
  FaPlay,
  FaTimes,
} from "react-icons/fa";

const POLL_MS = 1000; // Poll every 1s - backend does 4x micro-sampling (50ms) to catch sharp spikes

const severityRank: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityColor(severity: Severity = "info") {
  switch (severity) {
    case "critical":
      return "#ff5f57";
    case "high":
      return "#ff8a3d";
    case "medium":
      return "#f1c40f";
    case "low":
      return "#8ab4f8";
    default:
      return "rgba(255,255,255,0.72)";
  }
}

// Types
type PluginMetrics = {
  name: string;
  cpu: number;
  memory: number;
  peakCpu: number;
  peakMemory: number;
  processes: number;
  spike: boolean;
  spikeReason: string;
};

type Severity = "info" | "low" | "medium" | "high" | "critical";

type KnownIssue = {
  id: string;
  severity: Severity;
  title: string;
  advice: string;
  count: number;
  files: string[];
  examples: string[];
};

type LogAlert = {
  id: string;
  severity: Severity;
  title: string;
  message: string;
};

type LogRate = {
  bytesPerSecond: number;
  linesPerSecond: number;
  errorsPerSecond: number;
  active: boolean;
};

type PluginLogs = {
  name?: string;
  folder?: string;
  errors: number;
  examples: string[];
  knownIssues?: KnownIssue[];
  alerts?: LogAlert[];
  rate?: LogRate;
  severity?: Severity;
  serious?: boolean;
};

type PluginRow = {
  folder: string;
  name: string;
  version: string;
  disabled: boolean;
  logs?: PluginLogs;
  metrics?: PluginMetrics;
};

type Snapshot = {
  plugins: PluginRow[];
  logs: {
    plugins: PluginLogs[];
    totals: {
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
  };
  metrics: {
    cpu: number;
    memory: { used: number; total: number; percent: number };
    plugins: PluginMetrics[];
  };
};

type ActionResult = { ok: boolean; message: string };
type UpdateStatus = ActionResult & {
  current?: string;
  latest?: string;
  elevated?: boolean;
  hasUpdate?: boolean;
  canInstall?: boolean;
  installedVersion?: string;
  requiresRestart?: boolean;
  restarted?: boolean;
};
type MonitoringState = {
  enabled: boolean;
  metrics?: Snapshot["metrics"] | null;
  logs?: Snapshot["logs"] | null;
  pollIntervalMs?: number;
};

// API Calls
const getSnapshot = callable<[], Snapshot>("get_snapshot");
const clearLogs = callable<[name?: string], ActionResult>("clear_logs");
const disablePlugin = callable<[name: string], ActionResult>("disable_plugin");
const enablePlugin = callable<[name: string], ActionResult>("enable_plugin");
const killPluginProcesses = callable<[name: string], ActionResult>("kill_plugin_processes");
const resetMetrics = callable<[], ActionResult>("reset_metrics");
const getUpdateStatus = callable<[], UpdateStatus>("get_update_status");
const checkUpdate = callable<[force?: boolean], UpdateStatus>("check_update");
const installUpdate = callable<[], UpdateStatus>("install_update");
const getMonitoringState = callable<[], MonitoringState>("get_monitoring_state");
const setMonitoringEnabled = callable<[enabled: boolean], MonitoringState>("set_monitoring");

// Main Hook
function useTaskManager() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [monitoring, setMonitoring] = useState(false); // OFF by default to reduce overhead
  const [loading, setLoading] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [killingPlugin, setKillingPlugin] = useState<string>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [updating, setUpdating] = useState(false);

  const applyMetrics = (metrics: Snapshot["metrics"]) => {
    setSnapshot((current) => {
      if (!current) return current;

      return {
        ...current,
        metrics,
        plugins: current.plugins.map((p) => ({
          ...p,
          metrics: metrics.plugins.find((m) => m.name === p.name) || p.metrics,
        })),
      };
    });
  };

  const applyLogs = (logs: Snapshot["logs"]) => {
    setSnapshot((current) => {
      if (!current) return current;

      return {
        ...current,
        logs,
        plugins: current.plugins.map((p) => ({
          ...p,
          logs: logs.plugins.find((row) => row.name === p.name) || p.logs,
        })),
      };
    });
  };

  const refresh = async () => {
    try {
      const data = await getSnapshot();
      setSnapshot(data);
    } catch (error) {
      toaster.toast({ title: "Error", body: "Failed to load data" });
    }
  };

  const syncMonitoringState = async () => {
    const state = await getMonitoringState();
    setMonitoring(state.enabled);
    if (state.metrics) {
      applyMetrics(state.metrics);
    }
    if (state.logs) {
      applyLogs(state.logs);
    }
    return state;
  };

  const refreshMetrics = async () => {
    if (!monitoring) return;
    try {
      const state = await syncMonitoringState();
      if (!state.enabled) return;
    } catch {
      // Silently fail metric updates
    }
  };

  const handleMonitoringChange = async (enabled: boolean) => {
    const previous = monitoring;
    setMonitoring(enabled);
    try {
      const state = await setMonitoringEnabled(enabled);
      setMonitoring(state.enabled);
      if (state.metrics) {
        applyMetrics(state.metrics);
      }
    } catch {
      setMonitoring(previous);
      toaster.toast({ title: "Error", body: "Failed to update live monitoring" });
    }
  };

  const handleClearLogs = async (name?: string) => {
    try {
      const result = await clearLogs(name);
      toaster.toast({ title: "Success", body: result.message });
      await refresh();
    } catch {
      toaster.toast({ title: "Error", body: "Failed to clear logs" });
    }
  };

  const handleTogglePlugin = async (name: string, currentlyDisabled: boolean) => {
    if (name === "Decky Task Manager" && !currentlyDisabled) {
      toaster.toast({ title: "Error", body: "Cannot disable itself" });
      return;
    }
    setBusyPlugin(name);
    try {
      const result = currentlyDisabled 
        ? await enablePlugin(name)
        : await disablePlugin(name);
      toaster.toast({ title: result.ok ? "Success" : "Error", body: result.message });
      if (result.ok) await refresh();
    } catch {
      toaster.toast({ title: "Error", body: `Failed to ${currentlyDisabled ? 'enable' : 'disable'} plugin` });
    } finally {
      setBusyPlugin(undefined);
    }
  };

  const handleKillPlugin = async (name: string) => {
    if (name === "Decky Task Manager") {
      toaster.toast({ title: "Error", body: "Cannot kill itself" });
      return;
    }

    setKillingPlugin(name);
    try {
      const result = await killPluginProcesses(name);
      toaster.toast({ title: result.ok ? "Process Signal Sent" : "Error", body: result.message });
      await refresh();
      await syncMonitoringState();
    } catch {
      toaster.toast({ title: "Error", body: `Failed to kill ${name}` });
    } finally {
      setKillingPlugin(undefined);
    }
  };

  const handleTestMode = async () => {
    setLoading(true);
    try {
      await clearLogs();
      await resetMetrics();
      const state = await setMonitoringEnabled(true);
      setMonitoring(state.enabled);
      if (state.metrics) {
        applyMetrics(state.metrics);
      }
      toaster.toast({ title: "Test Mode", body: "Logs cleared, metrics reset" });
      await refresh();
    } catch {
      toaster.toast({ title: "Error", body: "Failed to start test mode" });
    } finally {
      setLoading(false);
    }
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    try {
      const result = await checkUpdate(true);
      setUpdateStatus(result);
      toaster.toast({ title: "Update Check", body: result.message });
    } catch {
      toaster.toast({ title: "Error", body: "Failed to check updates" });
    } finally {
      setUpdating(false);
    }
  };

  const handleInstallUpdate = async () => {
    setUpdating(true);
    try {
      const result = await installUpdate();
      setUpdateStatus(result);
      toaster.toast({ title: result.ok ? "Success" : "Error", body: result.message });
      if (result.ok) {
        window.setTimeout(() => {
          getUpdateStatus().then(setUpdateStatus).catch(() => undefined);
        }, 2500);
      }
    } catch {
      toaster.toast({ title: "Error", body: "Failed to install update" });
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      refresh(),
      syncMonitoringState(),
      getUpdateStatus().then(setUpdateStatus),
    ])
      .catch(() => {
        toaster.toast({ title: "Error", body: "Failed to load monitoring state" });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!monitoring) return;
    const timer = setInterval(refreshMetrics, POLL_MS);
    return () => clearInterval(timer);
  }, [monitoring]);

  return {
    snapshot,
    monitoring,
    setMonitoring: handleMonitoringChange,
    loading,
    busyPlugin,
    killingPlugin,
    updateStatus,
    updating,
    handleClearLogs,
    handleTogglePlugin,
    handleKillPlugin,
    handleTestMode,
    handleCheckUpdate,
    handleInstallUpdate,
    refresh,
  };
}

// Progress Bar Component
const ProgressBar: FC<{ value: number; color?: string; danger?: boolean }> = ({ value, color, danger }) => (
  <div style={{ padding: "4px 16px 10px" }}>
    <div
      style={{
        height: "8px",
        background: "rgba(255,255,255,0.1)",
        borderRadius: "4px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.min(100, Math.max(0, value))}%`,
          background: danger ? "#e74c3c" : color || "#3498db",
          transition: "width 0.3s ease",
        }}
      />
    </div>
  </div>
);

const SquareIconButton: FC<{
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}> = ({ label, disabled, danger, onClick, children }) => {
  const activate = () => {
    if (!disabled) onClick();
  };

  return (
    <Focusable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      title={label}
      onActivate={activate}
      onClick={activate}
      style={{
        width: "32px",
        minWidth: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "4px",
        background: danger ? "rgba(231, 76, 60, 0.22)" : "rgba(255,255,255,0.10)",
        color: danger ? "#ff8a80" : "rgba(255,255,255,0.88)",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </Focusable>
  );
};

// Main Dashboard Component
const Dashboard: FC = () => {
  const state = useTaskManager();
  const [activeTab, setActiveTab] = useState<"overview" | "plugins" | "logs">("overview");
  const alertedLogKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    const plugins = state.snapshot?.plugins || [];
    for (const plugin of plugins) {
      const logs = plugin.logs;
      if (!logs) continue;

      for (const issue of logs.knownIssues || []) {
        if (severityRank[issue.severity] < severityRank.high) continue;
        const key = `${plugin.name}:issue:${issue.id}`;
        if (alertedLogKeys.current.has(key)) continue;
        alertedLogKeys.current.add(key);
        toaster.toast({
          title: `${plugin.name}: ${issue.title}`,
          body: issue.advice,
          critical: issue.severity === "critical",
        });
      }

      for (const alert of logs.alerts || []) {
        const key = `${plugin.name}:alert:${alert.id}`;
        if (alertedLogKeys.current.has(key)) continue;
        alertedLogKeys.current.add(key);
        toaster.toast({
          title: `${plugin.name}: ${alert.title}`,
          body: alert.message,
          critical: alert.severity === "high" || alert.severity === "critical",
        });
      }
    }
  }, [state.snapshot?.logs]);

  if (state.loading && !state.snapshot) {
    return (
      <PanelSection title="Loading">
        <PanelSectionRow>
          <div style={{ padding: "20px", textAlign: "center", opacity: 0.6 }}>Loading data...</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const metrics = state.snapshot?.metrics;
  const plugins = state.snapshot?.plugins || [];
  const logTotals = state.snapshot?.logs.totals;
  const errorCount = logTotals?.errors || 0;
  const activePlugins = plugins.filter((p) => (p.metrics?.processes || 0) > 0);
  const errorPlugins = plugins.filter((p) => (p.logs?.errors || 0) > 0);
  const alertPlugins = plugins.filter((p) => p.logs?.serious || (p.logs?.alerts?.length || 0) > 0);

  // Calculate total plugin resource usage
  const totalPluginCpu = activePlugins.reduce((sum, p) => sum + (p.metrics?.cpu || 0), 0);
  const totalPluginRam = activePlugins.reduce((sum, p) => sum + (p.metrics?.memory || 0), 0);
  const systemCpu = metrics?.cpu || 0;
  const systemRamPercent = metrics?.memory.percent || 0;

  return (
    <>
      {/* Tab Navigation */}
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setActiveTab("overview")} disabled={activeTab === "overview"}>
            Overview
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setActiveTab("plugins")} disabled={activeTab === "plugins"}>
            Plugins ({activePlugins.length})
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setActiveTab("logs")} disabled={activeTab === "logs"}>
            Logs {errorCount > 0 && `(${errorCount})`}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <>
          <PanelSection title="Monitoring">
            <PanelSectionRow>
              <ToggleField
                label="Live Monitoring"
                description={state.monitoring ? "Updating every 1s (micro-sampling for spikes)" : "OFF - Showing snapshot only"}
                checked={state.monitoring}
                onChange={(val) => state.setMonitoring(val)}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={state.handleTestMode} disabled={state.loading}>
                <FaVial /> Start Test Mode
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field
                focusable
                label="Test Mode"
                description="Clears logs and metric peaks, then starts fresh monitoring."
              />
            </PanelSectionRow>
            {!state.monitoring && (
              <PanelSectionRow>
                <Field
                  focusable
                  label="Live monitoring is off"
                  description="CPU/RAM metrics are snapshots only and may be outdated."
                >
                  <div style={{ color: "#f39c12", fontWeight: 600 }}>OFF</div>
                </Field>
              </PanelSectionRow>
            )}
          </PanelSection>

          {alertPlugins.length > 0 && (
            <PanelSection title={`Alerts (${(logTotals?.serious || 0) + (logTotals?.alerts || 0)})`}>
              {alertPlugins.slice(0, 4).map((plugin) => {
                const logs = plugin.logs;
                const topIssue = logs?.knownIssues?.[0];
                const topAlert = logs?.alerts?.[0];
                const severity = logs?.severity || topIssue?.severity || topAlert?.severity || "info";
                const title = topIssue?.title || topAlert?.title || "Log issue";
                const description = topIssue?.advice || topAlert?.message || `${logs?.errors || 0} errors found`;

                return (
                  <PanelSectionRow key={plugin.name}>
                    <Field focusable label={`${plugin.name}: ${title}`} description={description}>
                      <div style={{ color: severityColor(severity), fontWeight: 700, textTransform: "capitalize" }}>
                        {severity}
                      </div>
                    </Field>
                  </PanelSectionRow>
                );
              })}
            </PanelSection>
          )}

          <PanelSection title="Plugin Resources">
            <PanelSectionRow>
                <Field 
                  focusable
                  label={<><FaMicrochip /> Plugin CPU Usage{!state.monitoring && " !"}</>}
                  description={state.monitoring 
                    ? `${totalPluginCpu.toFixed(1)}% of ${systemCpu.toFixed(1)}% total` 
                    : "Snapshot - Enable live monitoring for real-time"
                  }
                >
                  <div style={{ fontSize: "24px", fontWeight: "bold", color: totalPluginCpu > 50 ? "#e74c3c" : "#3498db" }}>
                    {totalPluginCpu.toFixed(1)}%
                  </div>
                </Field>
            </PanelSectionRow>
            <ProgressBar value={totalPluginCpu} danger={totalPluginCpu > 50} />

            <PanelSectionRow>
                <Field
                  focusable
                  label={<><FaMemory /> Plugin RAM Usage{!state.monitoring && " !"}</>}
                  description={state.monitoring 
                    ? `${totalPluginRam} MB used by ${activePlugins.length} plugin${activePlugins.length === 1 ? '' : 's'}` 
                    : "Snapshot - Enable live monitoring for real-time"
                  }
                >
                  <div style={{ fontSize: "24px", fontWeight: "bold", color: "#2ecc71" }}>
                    {totalPluginRam} MB
                  </div>
                </Field>
            </PanelSectionRow>
            <ProgressBar value={(totalPluginRam / (metrics?.memory.total || 16000)) * 100} color="#2ecc71" />
          </PanelSection>

          <PanelSection title="Status">
            <PanelSectionRow>
                <Field focusable label="System Load" description={`${systemCpu.toFixed(1)}% CPU, ${systemRamPercent}% RAM`}>
                  <div style={{ fontSize: "16px", opacity: 0.8 }}>
                    {systemCpu > 85 ? "High" : systemCpu > 60 ? "Moderate" : "Normal"}
                  </div>
                </Field>
            </PanelSectionRow>
            <PanelSectionRow>
                <Field focusable label="Active Plugins" description={`${plugins.length} total installed`}>
                  <div style={{ fontSize: "20px", fontWeight: "600" }}>{activePlugins.length}</div>
                </Field>
            </PanelSectionRow>
            <PanelSectionRow>
                <Field focusable label="Log Errors" description={errorPlugins.length > 0 ? `${errorPlugins.length} plugins affected` : "All clean"}>
                  <div style={{ fontSize: "20px", fontWeight: "600", color: errorCount > 0 ? "#e74c3c" : "#2ecc71" }}>
                    {errorCount}
                  </div>
                </Field>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Updates">
            <PanelSectionRow>
                <Field
                  focusable
                  label="Version"
                  description={state.updateStatus?.requiresRestart ? "Restart pending" : state.updateStatus?.hasUpdate ? "Update available!" : "Up to date"}
                >
                  <div style={{ fontSize: "16px" }}>{state.updateStatus?.current || "Unknown"}</div>
                </Field>
            </PanelSectionRow>
            {state.updateStatus?.hasUpdate && (
              <PanelSectionRow>
                  <Field focusable label="Latest Version">
                    <div style={{ fontSize: "16px", color: "#2ecc71" }}>{state.updateStatus.latest}</div>
                  </Field>
              </PanelSectionRow>
            )}
            {state.updateStatus?.elevated === false && (
              <PanelSectionRow>
                <Field focusable label="Update Permissions" description="Decky root permissions are required for self-update.">
                  <div style={{ color: "#ff8a3d", fontWeight: 700 }}>Missing</div>
                </Field>
              </PanelSectionRow>
            )}
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={state.handleCheckUpdate} disabled={state.updating}>
                <FaDownload /> {state.updating ? "Checking..." : "Check Update"}
              </ButtonItem>
            </PanelSectionRow>
            {state.updateStatus?.canInstall && (
              <PanelSectionRow>
                <ButtonItem layout="below" onClick={state.handleInstallUpdate} disabled={state.updating}>
                  {state.updating ? "Installing..." : state.updateStatus.hasUpdate ? "Install Update" : "Reinstall"}
                </ButtonItem>
              </PanelSectionRow>
            )}
          </PanelSection>
        </>
      )}

      {/* Plugins Tab */}
      {activeTab === "plugins" && (
        <>
          <PanelSection title={`Active Plugins (${activePlugins.length})`}>
            {activePlugins.length === 0 ? (
              <PanelSectionRow>
                <div style={{ padding: "20px", textAlign: "center", opacity: 0.6 }}>
                  <FaCheck /> No plugins currently running
                </div>
              </PanelSectionRow>
            ) : (
              activePlugins.map((plugin) => {
                const metrics = plugin.metrics;
                const hasErrors = (plugin.logs?.errors || 0) > 0;
                const hasSpike = metrics?.spike;
                const isCpuSpike = hasSpike && metrics.spikeReason?.toLowerCase().includes('cpu');
                const isRamSpike = hasSpike && metrics.spikeReason?.toLowerCase().includes('ram');

                return (
                  <PanelSectionRow key={plugin.name}>
                    <Field
                      label={
                        <span>
                          {hasSpike && "🔥 "}
                          {plugin.name}
                          {hasSpike && " 🔥"}
                        </span>
                      }
                      description={
                        <>
                          {plugin.version && `v${plugin.version} · `}
                          {metrics?.processes || 0} process{metrics?.processes === 1 ? "" : "es"}
                          {hasErrors && ` · ${plugin.logs?.errors} errors`}
                          {hasSpike && (
                            <span style={{ color: "#e74c3c", fontWeight: "bold" }}>
                              {" "}· ⚠️ {metrics.spikeReason}
                            </span>
                          )}
                        </>
                      }
                    >
                      <div style={{ fontSize: "14px" }}>
                        <div>CPU: <span style={{
                          color: isCpuSpike ? "#e74c3c" : "#3498db",
                          fontWeight: isCpuSpike ? "bold" : "normal"
                        }}>{metrics?.cpu?.toFixed(1) || 0}%</span> <span style={{ opacity: 0.65 }}>
                          max {metrics?.peakCpu?.toFixed(1) || 0}%
                        </span></div>
                        <div>RAM: <span style={{
                          color: isRamSpike ? "#e74c3c" : "#2ecc71",
                          fontWeight: isRamSpike ? "bold" : "normal"
                        }}>{metrics?.memory || 0} MB</span> <span style={{ opacity: 0.65 }}>
                          max {metrics?.peakMemory || 0} MB
                        </span></div>
                      </div>
                    </Field>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", width: "100%" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ButtonItem
                          layout="below"
                          onClick={() => state.handleTogglePlugin(plugin.name, plugin.disabled)}
                          disabled={state.busyPlugin === plugin.name || state.killingPlugin === plugin.name}
                        >
                          {state.busyPlugin === plugin.name ? (
                            plugin.disabled ? "Enabling..." : "Disabling..."
                          ) : (
                            <><FaBan /> Disable</>
                          )}
                        </ButtonItem>
                      </div>
                      <SquareIconButton
                        label={`Kill ${plugin.name}`}
                        danger
                        onClick={() => state.handleKillPlugin(plugin.name)}
                        disabled={state.killingPlugin === plugin.name || state.busyPlugin === plugin.name}
                      >
                        <FaTimes />
                      </SquareIconButton>
                    </div>
                  </PanelSectionRow>
                );
              })
            )}
          </PanelSection>

          <PanelSection title={`All Plugins (${plugins.length})`}>
            {plugins.map((plugin) => {
              const isActive = (plugin.metrics?.processes || 0) > 0;
              if (isActive) return null; // Already shown above

              return (
                <PanelSectionRow key={plugin.name}>
                  <Field
                    label={plugin.name}
                    description={plugin.disabled ? "Disabled" : "Idle"}
                  >
                    <ButtonItem
                      layout="below"
                      onClick={() => state.handleTogglePlugin(plugin.name, plugin.disabled)}
                      disabled={state.busyPlugin === plugin.name}
                    >
                      {state.busyPlugin === plugin.name ? (
                        plugin.disabled ? "Enabling..." : "Disabling..."
                      ) : plugin.disabled ? (
                        <><FaPlay /> Enable</>
                      ) : (
                        <><FaBan /> Disable</>
                      )}
                    </ButtonItem>
                  </Field>
                </PanelSectionRow>
              );
            })}
          </PanelSection>
        </>
      )}

      {/* Logs Tab */}
      {activeTab === "logs" && (
        <>
          <PanelSection title={`Errors (${errorCount})`}>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => state.handleClearLogs()} disabled={state.loading}>
                <FaEraser /> Clear All Logs
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>

          {errorCount === 0 ? (
            <PanelSection>
              <PanelSectionRow>
                <div style={{ padding: "20px", textAlign: "center", opacity: 0.6 }}>
                  <FaCheck /> No errors found
                </div>
              </PanelSectionRow>
            </PanelSection>
          ) : (
            errorPlugins.map((plugin) => (
              <PanelSection key={plugin.name} title={plugin.name}>
                <PanelSectionRow>
                  <Field
                    focusable
                    label="Errors Found"
                    description={plugin.logs?.severity ? `Severity: ${plugin.logs.severity}` : "Error count in logs"}
                  >
                    <div style={{ fontSize: "20px", fontWeight: "600", color: "#e74c3c" }}>
                      {plugin.logs?.errors || 0}
                    </div>
                  </Field>
                </PanelSectionRow>

                {(plugin.logs?.alerts || []).map((alert) => (
                  <PanelSectionRow key={alert.id}>
                    <Field focusable label={alert.title} description={alert.message}>
                      <div style={{ color: severityColor(alert.severity), fontWeight: 700, textTransform: "capitalize" }}>
                        {alert.severity}
                      </div>
                    </Field>
                  </PanelSectionRow>
                ))}

                {(plugin.logs?.knownIssues || []).slice(0, 3).map((issue) => (
                  <PanelSectionRow key={issue.id}>
                    <Field focusable label={issue.title} description={`${issue.advice} (${issue.count} matches)`}>
                      <div style={{ color: severityColor(issue.severity), fontWeight: 700, textTransform: "capitalize" }}>
                        {issue.severity}
                      </div>
                    </Field>
                  </PanelSectionRow>
                ))}

                {plugin.logs?.rate?.active && (
                  <PanelSectionRow>
                    <Field
                      focusable
                      label="Log Write Rate"
                      description={`${plugin.logs.rate.linesPerSecond.toFixed(1)} lines/sec, ${plugin.logs.rate.errorsPerSecond.toFixed(2)} errors/sec`}
                    >
                      <div style={{ color: "#f1c40f", fontWeight: 700 }}>
                        {(plugin.logs.rate.bytesPerSecond / 1024).toFixed(1)} KB/s
                      </div>
                    </Field>
                  </PanelSectionRow>
                )}

                {plugin.logs?.examples.slice(0, 2).map((example, i) => (
                  <Focusable key={i} style={{ padding: "12px 16px" }}>
                    <div
                      style={{
                        fontSize: "11px",
                        fontFamily: "monospace",
                        background: "rgba(255,255,255,0.05)",
                        padding: "8px",
                        borderRadius: "4px",
                        overflow: "auto",
                        maxHeight: "60px",
                        lineHeight: 1.3,
                      }}
                    >
                      {example}
                    </div>
                  </Focusable>
                ))}

                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={() => state.handleClearLogs(plugin.name)}>
                    <FaEraser /> Clear {plugin.name} Logs
                  </ButtonItem>
                </PanelSectionRow>
              </PanelSection>
            ))
          )}
        </>
      )}
      <small>By Yuri</small>
    </>
  );
};

// Plugin Definition
export default definePlugin(() => {
  return {
    name: "Decky Task Manager",
    titleView: <div className={staticClasses.Title}>Task Manager</div>,
    content: <Dashboard />,
    icon: <FaTasks />,
  };
});
