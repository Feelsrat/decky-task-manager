import { toaster } from "@decky/api";
import { useEffect, useState } from "react";
import * as api from "./api";
import { SELF_NAME, severityRank } from "./ui/theme";
import type { Logs, Metrics, Snapshot, UpdateStatus } from "./types";

const POLL_MS = 1000; // Backend does 4x micro-sampling (50ms) per poll to catch sharp spikes

// Module scope so alerts are not re-toasted every time the QAM panel remounts
const alertedLogKeys = new Set<string>();
let alertsPrimed = false;

type PendingAlert = { title: string; body: string; critical: boolean };

/**
 * Toast serious log problems that appear while the user isn't looking. Problems already present
 * the first time the panel loads are on screen anyway, so they are only marked as seen.
 */
function toastNewLogAlerts(snapshot: Snapshot) {
  const fresh: PendingAlert[] = [];
  const remember = (key: string, alert: PendingAlert) => {
    if (alertedLogKeys.has(key)) return;
    alertedLogKeys.add(key);
    fresh.push(alert);
  };

  for (const plugin of snapshot.plugins) {
    const logs = plugin.logs;
    if (!logs) continue;

    for (const issue of logs.knownIssues || []) {
      if (severityRank[issue.severity] < severityRank.high) continue;
      remember(`${plugin.name}:issue:${issue.id}`, {
        title: `${plugin.name}: ${issue.title}`,
        body: issue.advice,
        critical: issue.severity === "critical",
      });
    }

    for (const alert of logs.alerts || []) {
      remember(`${plugin.name}:alert:${alert.id}`, {
        title: `${plugin.name}: ${alert.title}`,
        body: alert.message,
        critical: alert.severity === "high" || alert.severity === "critical",
      });
    }
  }

  if (!alertsPrimed) {
    alertsPrimed = true;
    return;
  }
  if (fresh.length === 1) {
    toaster.toast(fresh[0]);
  } else if (fresh.length > 1) {
    toaster.toast({
      title: `Task Manager: ${fresh.length} new log problems`,
      body: fresh.map((alert) => alert.title).join(", "),
      critical: fresh.some((alert) => alert.critical),
    });
  }
}

export function useTaskManager() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [monitoring, setMonitoring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [killingPlugin, setKillingPlugin] = useState<string>();
  const [clearingLogs, setClearingLogs] = useState<string | true>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [updating, setUpdating] = useState<"check" | "install">();

  const applyMetrics = (metrics: Metrics) => {
    setSnapshot((current) => {
      if (!current) return current;

      return {
        ...current,
        metrics,
        // Plugins that stopped running must drop their old metrics
        plugins: current.plugins.map((p) => ({
          ...p,
          metrics: metrics.plugins.find((m) => m.name === p.name),
        })),
      };
    });
  };

  const applyLogs = (logs: Logs) => {
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
    setRefreshing(true);
    try {
      setSnapshot(await api.getSnapshot());
    } catch {
      toaster.toast({ title: "Task Manager", body: "Failed to load plugin data" });
    } finally {
      setRefreshing(false);
    }
  };

  const syncMonitoringState = async () => {
    const state = await api.getMonitoringState();
    setMonitoring(state.enabled);
    if (state.metrics) applyMetrics(state.metrics);
    if (state.logs) applyLogs(state.logs);
    return state;
  };

  const setMonitoringEnabled = async (enabled: boolean) => {
    const previous = monitoring;
    setMonitoring(enabled);
    try {
      const state = await api.setMonitoringEnabled(enabled);
      setMonitoring(state.enabled);
      if (state.metrics) applyMetrics(state.metrics);
    } catch {
      setMonitoring(previous);
      toaster.toast({ title: "Task Manager", body: "Failed to update live monitoring" });
    }
  };

  const clearLogs = async (name?: string) => {
    setClearingLogs(name ?? true);
    try {
      const result = await api.clearLogs(name);
      toaster.toast({ title: "Logs cleared", body: result.message });
      await refresh();
    } catch {
      toaster.toast({ title: "Task Manager", body: "Failed to clear logs" });
    } finally {
      setClearingLogs(undefined);
    }
  };

  const togglePlugin = async (name: string, currentlyDisabled: boolean) => {
    if (name === SELF_NAME && !currentlyDisabled) {
      toaster.toast({ title: "Task Manager", body: "Task Manager can't disable itself" });
      return;
    }
    setBusyPlugin(name);
    try {
      const result = currentlyDisabled ? await api.enablePlugin(name) : await api.disablePlugin(name);
      toaster.toast({ title: result.ok ? name : "Task Manager", body: result.message });
      if (result.ok) await refresh();
    } catch {
      toaster.toast({
        title: "Task Manager",
        body: `Failed to ${currentlyDisabled ? "enable" : "disable"} ${name}`,
      });
    } finally {
      setBusyPlugin(undefined);
    }
  };

  const killPlugin = async (name: string) => {
    if (name === SELF_NAME) {
      toaster.toast({ title: "Task Manager", body: "Task Manager can't stop itself" });
      return;
    }

    setKillingPlugin(name);
    try {
      const result = await api.killPluginProcesses(name);
      toaster.toast({ title: result.ok ? name : "Task Manager", body: result.message });
      await refresh();
      await syncMonitoringState();
    } catch {
      toaster.toast({ title: "Task Manager", body: `Failed to stop ${name}` });
    } finally {
      setKillingPlugin(undefined);
    }
  };

  const startFreshCapture = async () => {
    setLoading(true);
    try {
      await api.clearLogs();
      await api.resetMetrics();
      const state = await api.setMonitoringEnabled(true);
      setMonitoring(state.enabled);
      await refresh();
      if (state.metrics) applyMetrics(state.metrics);
      toaster.toast({ title: "Fresh capture started", body: "Logs cleared, peaks reset, live monitoring on" });
    } catch {
      toaster.toast({ title: "Task Manager", body: "Failed to start a fresh capture" });
    } finally {
      setLoading(false);
    }
  };

  const checkForUpdate = async () => {
    setUpdating("check");
    try {
      const result = await api.checkUpdate(true);
      setUpdateStatus(result);
      toaster.toast({ title: "Task Manager", body: result.message });
    } catch {
      toaster.toast({ title: "Task Manager", body: "Failed to check for updates" });
    } finally {
      setUpdating(undefined);
    }
  };

  const installUpdate = async () => {
    setUpdating("install");
    try {
      const result = await api.installUpdate();
      setUpdateStatus(result);
      toaster.toast({ title: "Task Manager", body: result.message });
      if (result.ok) {
        window.setTimeout(() => {
          api.getUpdateStatus().then(setUpdateStatus).catch(() => undefined);
        }, 2500);
      }
    } catch {
      toaster.toast({ title: "Task Manager", body: "Failed to install the update" });
    } finally {
      setUpdating(undefined);
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([refresh(), syncMonitoringState(), api.getUpdateStatus().then(setUpdateStatus)])
      .catch(() => {
        toaster.toast({ title: "Task Manager", body: "Failed to load monitoring state" });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!monitoring) return;
    const timer = setInterval(() => {
      syncMonitoringState().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [monitoring]);

  useEffect(() => {
    if (snapshot) toastNewLogAlerts(snapshot);
  }, [snapshot?.logs]);

  return {
    snapshot,
    monitoring,
    loading,
    refreshing,
    busyPlugin,
    killingPlugin,
    clearingLogs,
    updateStatus,
    updating,
    refresh,
    setMonitoringEnabled,
    clearLogs,
    togglePlugin,
    killPlugin,
    startFreshCapture,
    checkForUpdate,
    installUpdate,
  };
}

export type TaskManager = ReturnType<typeof useTaskManager>;
