import { callable } from "@decky/api";
import type { ActionResult, MonitoringState, Snapshot, UpdateStatus } from "./types";

export const getSnapshot = callable<[], Snapshot>("get_snapshot");
export const clearLogs = callable<[name?: string], ActionResult>("clear_logs");
export const disablePlugin = callable<[name: string], ActionResult>("disable_plugin");
export const enablePlugin = callable<[name: string], ActionResult>("enable_plugin");
export const killPluginProcesses = callable<[name: string], ActionResult>("kill_plugin_processes");
export const resetMetrics = callable<[], ActionResult>("reset_metrics");
export const getUpdateStatus = callable<[], UpdateStatus>("get_update_status");
export const checkUpdate = callable<[force?: boolean], UpdateStatus>("check_update");
export const installUpdate = callable<[], UpdateStatus>("install_update");
export const getMonitoringState = callable<[], MonitoringState>("get_monitoring_state");
export const setMonitoringEnabled = callable<[enabled: boolean], MonitoringState>("set_monitoring");
