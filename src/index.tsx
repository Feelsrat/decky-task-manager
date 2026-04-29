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
import { useEffect, useState, FC } from "react";
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
} from "react-icons/fa";

const POLL_MS = 1000; // Poll every 1s - backend does 4x micro-sampling (50ms) to catch sharp spikes

// Types
type PluginMetrics = {
  name: string;
  cpu: number;
  memory: number;
  processes: number;
  spike: boolean;
  spikeReason: string;
};

type PluginRow = {
  folder: string;
  name: string;
  version: string;
  disabled: boolean;
  logs?: {
    errors: number;
    examples: string[];
  };
  metrics?: PluginMetrics;
};

type Snapshot = {
  plugins: PluginRow[];
  logs: {
    totals: { errors: number };
  };
  metrics: {
    cpu: number;
    memory: { used: number; total: number; percent: number };
    plugins: PluginMetrics[];
  };
};

type ActionResult = { ok: boolean; message: string };
type UpdateStatus = ActionResult & { current?: string; latest?: string; hasUpdate?: boolean; canInstall?: boolean };

// API Calls
const getSnapshot = callable<[], Snapshot>("get_snapshot");
const getMetrics = callable<[], any>("get_metrics");
const clearLogs = callable<[name?: string], ActionResult>("clear_logs");
const disablePlugin = callable<[name: string], ActionResult>("disable_plugin");
const enablePlugin = callable<[name: string], ActionResult>("enable_plugin");
const resetMetrics = callable<[], ActionResult>("reset_metrics");
const checkUpdate = callable<[], UpdateStatus>("check_update");
const installUpdate = callable<[], UpdateStatus>("install_update");

// Main Hook
function useTaskManager() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [monitoring, setMonitoring] = useState(false); // OFF by default to reduce overhead
  const [loading, setLoading] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [updating, setUpdating] = useState(false);

  const refresh = async () => {
    try {
      const data = await getSnapshot();
      setSnapshot(data);
    } catch (error) {
      toaster.toast({ title: "Error", body: "Failed to load data" });
    }
  };

  const refreshMetrics = async () => {
    if (!monitoring) return;
    try {
      const metrics = await getMetrics();
      if (snapshot) {
        setSnapshot({
          ...snapshot,
          metrics,
          plugins: snapshot.plugins.map((p) => ({
            ...p,
            metrics: metrics.plugins.find((m: PluginMetrics) => m.name === p.name) || p.metrics,
          })),
        });
      }
    } catch {
      // Silently fail metric updates
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

  const handleTestMode = async () => {
    setLoading(true);
    try {
      await clearLogs();
      await resetMetrics();
      setMonitoring(true);
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
      const result = await checkUpdate();
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
      toaster.toast({ title: result.ok ? "Success" : "Error", body: result.message });
    } catch {
      toaster.toast({ title: "Error", body: "Failed to install update" });
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
    
    // Auto-check for updates on startup (uses 24-hour cache)
    checkUpdate().then((result) => {
      setUpdateStatus(result);
      if (result.hasUpdate) {
        toaster.toast({ 
          title: "Update Available", 
          body: `Version ${result.latest} is available` 
        });
      }
    }).catch(() => {
      // Silently ignore update check failures
    });
  }, []);

  useEffect(() => {
    if (!monitoring) return;
    const timer = setInterval(refreshMetrics, POLL_MS);
    return () => clearInterval(timer);
  }, [monitoring, snapshot]);

  return {
    snapshot,
    monitoring,
    setMonitoring,
    loading,
    busyPlugin,
    updateStatus,
    updating,
    handleClearLogs,
    handleTogglePlugin,
    handleTestMode,
    handleCheckUpdate,
    handleInstallUpdate,
    refresh,
  };
}

// Progress Bar Component
const ProgressBar: FC<{ value: number; color?: string; danger?: boolean }> = ({ value, color, danger }) => (
  <Focusable style={{ marginTop: "8px" }}>
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
  </Focusable>
);

// Main Dashboard Component
const Dashboard: FC = () => {
  const state = useTaskManager();
  const [activeTab, setActiveTab] = useState<"overview" | "plugins" | "logs">("overview");

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
  const errorCount = state.snapshot?.logs.totals.errors || 0;
  const activePlugins = plugins.filter((p) => (p.metrics?.processes || 0) > 0);
  const errorPlugins = plugins.filter((p) => (p.logs?.errors || 0) > 0);

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
            <div style={{ padding: "8px 16px", fontSize: "12px", opacity: 0.7, lineHeight: 1.4 }}>
              Test mode clears logs and metrics, then starts monitoring. Use this to reproduce issues.
            </div>
            {!state.monitoring && (
              <div style={{ 
                padding: "8px 16px", 
                fontSize: "12px", 
                color: "#f39c12", 
                lineHeight: 1.4,
                background: "rgba(243, 156, 18, 0.1)",
                borderRadius: "4px",
                margin: "8px 16px"
              }}>
                ⚠️ Live monitoring is OFF. CPU/RAM metrics are snapshots only and may be outdated.
              </div>
            )}
          </PanelSection>

          <PanelSection title="Plugin Resources">
            <PanelSectionRow>
              <Focusable style={{ width: "100%", padding: "10px 0" }}>
                <Field 
                  label={<><FaMicrochip /> Plugin CPU Usage{!state.monitoring && " ⚠️"}</>} 
                  description={state.monitoring 
                    ? `${totalPluginCpu.toFixed(1)}% of ${systemCpu.toFixed(1)}% total` 
                    : "Snapshot - Enable live monitoring for real-time"
                  }
                >
                  <div style={{ fontSize: "24px", fontWeight: "bold", color: totalPluginCpu > 50 ? "#e74c3c" : "#3498db" }}>
                    {totalPluginCpu.toFixed(1)}%
                  </div>
                </Field>
              </Focusable>
            </PanelSectionRow>
            <ProgressBar value={totalPluginCpu} danger={totalPluginCpu > 50} />

            <PanelSectionRow>
              <Focusable style={{ width: "100%", padding: "10px 0" }}>
                <Field
                  label={<><FaMemory /> Plugin RAM Usage{!state.monitoring && " ⚠️"}</>}
                  description={state.monitoring 
                    ? `${totalPluginRam} MB used by ${activePlugins.length} plugin${activePlugins.length === 1 ? '' : 's'}` 
                    : "Snapshot - Enable live monitoring for real-time"
                  }
                >
                  <div style={{ fontSize: "24px", fontWeight: "bold", color: "#2ecc71" }}>
                    {totalPluginRam} MB
                  </div>
                </Field>
              </Focusable>
            </PanelSectionRow>
            <ProgressBar value={(totalPluginRam / (metrics?.memory.total || 16000)) * 100} color="#2ecc71" />
          </PanelSection>

          <PanelSection title="Status">
            <PanelSectionRow>
              <Focusable style={{ width: "100%", padding: "10px 0" }}>
                <Field label="System Load" description={`${systemCpu.toFixed(1)}% CPU, ${systemRamPercent}% RAM`}>
                  <div style={{ fontSize: "16px", opacity: 0.8 }}>
                    {systemCpu > 85 ? "⚠️ High" : systemCpu > 60 ? "Moderate" : "Normal"}
                  </div>
                </Field>
              </Focusable>
            </PanelSectionRow>
            <PanelSectionRow>
              <Focusable style={{ width: "100%", padding: "10px 0" }}>
                <Field label="Active Plugins" description={`${plugins.length} total installed`}>
                  <div style={{ fontSize: "20px", fontWeight: "600" }}>{activePlugins.length}</div>
                </Field>
              </Focusable>
            </PanelSectionRow>
            <PanelSectionRow>
              <Focusable style={{ width: "100%", padding: "10px 0" }}>
                <Field label="Log Errors" description={errorPlugins.length > 0 ? `${errorPlugins.length} plugins affected` : "All clean"}>
                  <div style={{ fontSize: "20px", fontWeight: "600", color: errorCount > 0 ? "#e74c3c" : "#2ecc71" }}>
                    {errorCount}
                  </div>
                </Field>
              </Focusable>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Updates">
            <PanelSectionRow>
              <Focusable style={{ width: "100%", padding: "10px 0" }}>
                <Field label="Version" description={state.updateStatus?.hasUpdate ? "Update available!" : "Up to date"}>
                  <div style={{ fontSize: "16px" }}>{state.updateStatus?.current || "Unknown"}</div>
                </Field>
              </Focusable>
            </PanelSectionRow>
            {state.updateStatus?.hasUpdate && (
              <PanelSectionRow>
                <Focusable style={{ width: "100%", padding: "10px 0" }}>
                  <Field label="Latest Version">
                    <div style={{ fontSize: "16px", color: "#2ecc71" }}>{state.updateStatus.latest}</div>
                  </Field>
                </Focusable>
              </PanelSectionRow>
            )}
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={state.handleCheckUpdate} disabled={state.updating}>
                <FaDownload /> Check Update
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
                        }}>{metrics?.cpu?.toFixed(1) || 0}%</span></div>
                        <div>RAM: <span style={{ 
                          color: isRamSpike ? "#e74c3c" : "#2ecc71",
                          fontWeight: isRamSpike ? "bold" : "normal"
                        }}>{metrics?.memory || 0} MB</span></div>
                      </div>
                    </Field>
                    <ButtonItem
                      layout="below"
                      onClick={() => state.handleTogglePlugin(plugin.name, plugin.disabled)}
                      disabled={state.busyPlugin === plugin.name}
                    >
                      {state.busyPlugin === plugin.name ? (
                        plugin.disabled ? "Enabling..." : "Disabling..."
                      ) : (
                        <><FaBan /> Disable</>
                      )}
                    </ButtonItem>
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
                  <Field label="Errors Found" description="Error count in logs">
                    <div style={{ fontSize: "20px", fontWeight: "600", color: "#e74c3c" }}>
                      {plugin.logs?.errors || 0}
                    </div>
                  </Field>
                </PanelSectionRow>

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
