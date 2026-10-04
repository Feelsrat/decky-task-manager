import { ButtonItem, Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import type { FC } from "react";
import { FaBolt, FaCheckCircle, FaChevronRight, FaDownload, FaExclamationTriangle, FaSyncAlt } from "react-icons/fa";
import type { TaskManager } from "../useTaskManager";
import type { PluginRow } from "../types";
import { activateHandlers } from "./activate";
import { ButtonRow, Chip, Dot, Meter, SmallButton, StatTile, confirmAction } from "./components";
import { colors, formatAge, formatMb, loadColor, plural, severityColor, severityRank } from "./theme";

type Health = { color: string; title: string; detail: string };

function healthSummary(plugins: PluginRow[], systemCpu: number, ramPercent: number): Health {
  const serious = plugins.filter((p) => p.logs?.serious);
  const critical = serious.filter((p) => p.logs?.severity === "critical");
  const spiking = plugins.filter((p) => p.metrics?.spike);

  if (critical.length > 0) {
    return {
      color: colors.red,
      title: `${plural(critical.length, "plugin")} failing`,
      detail: critical.map((p) => p.name).join(", "),
    };
  }
  if (serious.length > 0) {
    return {
      color: colors.orange,
      title: `${plural(serious.length, "plugin")} need${serious.length === 1 ? "s" : ""} attention`,
      detail: serious.map((p) => p.name).join(", "),
    };
  }
  if (systemCpu >= 85 || ramPercent >= 90) {
    return {
      color: colors.yellow,
      title: "System under heavy load",
      detail: spiking.length ? `Spiking: ${spiking.map((p) => p.name).join(", ")}` : "No single plugin stands out",
    };
  }
  if (spiking.length > 0) {
    return {
      color: colors.yellow,
      title: `${plural(spiking.length, "plugin")} spiking`,
      detail: spiking.map((p) => p.name).join(", "),
    };
  }
  return { color: colors.green, title: "Everything looks healthy", detail: "No serious log errors or resource spikes" };
}

export const OverviewTab: FC<{
  tm: TaskManager;
  now: number;
  openPlugin: (name: string) => void;
  openLogs: (name: string) => void;
}> = ({ tm, now, openPlugin, openLogs }) => {
  const snapshot = tm.snapshot;
  const metrics = snapshot?.metrics;
  const plugins = snapshot?.plugins || [];
  const history = metrics?.history || [];
  const cpu = metrics?.cpu || 0;
  const memory = metrics?.memory || { used: 0, total: 0, percent: 0 };
  const health = healthSummary(plugins, cpu, memory.percent);

  const running = plugins
    .filter((p) => (p.metrics?.processes || 0) > 0)
    .sort((a, b) => (b.metrics?.cpu || 0) - (a.metrics?.cpu || 0) || (b.metrics?.memory || 0) - (a.metrics?.memory || 0));
  const pluginCpu = running.reduce((sum, p) => sum + (p.metrics?.cpu || 0), 0);
  const pluginRam = running.reduce((sum, p) => sum + (p.metrics?.memory || 0), 0);

  const attention = plugins
    .filter((p) => p.logs?.serious || (p.logs?.alerts?.length || 0) > 0)
    .sort((a, b) => severityRank[b.logs?.severity || "info"] - severityRank[a.logs?.severity || "info"]);

  const update = tm.updateStatus;

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <div
            style={{
              display: "flex",
              gap: "10px",
              alignItems: "flex-start",
              padding: "10px 12px",
              marginBottom: "8px",
              borderRadius: "4px",
              borderLeft: `3px solid ${health.color}`,
              background: colors.card,
            }}
          >
            <div style={{ color: health.color, fontSize: "18px", display: "flex", paddingTop: "2px" }}>
              {health.color === colors.green ? <FaCheckCircle /> : <FaExclamationTriangle />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: colors.text }}>{health.title}</div>
              <div style={{ fontSize: "12px", color: colors.muted, marginTop: "2px" }}>{health.detail}</div>
            </div>
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ display: "flex", gap: "8px" }}>
            <StatTile
              label="CPU"
              value={`${cpu.toFixed(0)}%`}
              sub={`Plugins ${pluginCpu.toFixed(1)}%`}
              color={loadColor(cpu)}
              history={history.map((h) => h.cpu)}
            />
            <StatTile
              label="RAM"
              value={`${memory.percent.toFixed(0)}%`}
              sub={`${formatMb(memory.used)} of ${formatMb(memory.total)}`}
              color={loadColor(memory.percent, 75, 90)}
              history={history.map((h) => h.memory)}
            />
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: colors.muted, padding: "6px 2px 4px" }}>
            <Dot color={tm.monitoring ? colors.green : colors.muted} />
            {tm.monitoring ? "Live" : "Snapshot"} · updated {formatAge(metrics?.timestamp, now)}
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Monitoring">
        <PanelSectionRow>
          <ToggleField
            label="Live monitoring"
            description={
              tm.monitoring
                ? "Sampling every second. Keeps running while this menu is closed."
                : "Off. Numbers are a one-off snapshot."
            }
            checked={tm.monitoring}
            onChange={(value) => tm.setMonitoringEnabled(value)}
          />
        </PanelSectionRow>
        {!tm.monitoring && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => tm.refresh()} disabled={tm.refreshing}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                <FaSyncAlt /> {tm.refreshing ? "Refreshing..." : "Refresh snapshot"}
              </span>
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>

      {attention.length > 0 && (
        <PanelSection title="Needs attention">
          {attention.slice(0, 4).map((plugin) => {
            const logs = plugin.logs;
            const issue = logs?.knownIssues?.[0];
            const alert = logs?.alerts?.[0];
            const severity = logs?.severity || "info";
            return (
              <PanelSectionRow key={plugin.name}>
                <Field
                  focusable
                  highlightOnFocus
                  label={plugin.name}
                  description={issue?.title || alert?.title || plural(logs?.errors || 0, "error")}
                  {...activateHandlers(() => openLogs(plugin.name))}
                >
                  <Chip color={severityColor(severity)}>{severity}</Chip>
                </Field>
              </PanelSectionRow>
            );
          })}
        </PanelSection>
      )}

      <PanelSection title={`Top plugins · ${formatMb(pluginRam)}`}>
        {running.length === 0 ? (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", color: colors.muted, padding: "4px 0 8px" }}>
              No plugin backends are running right now.
            </div>
          </PanelSectionRow>
        ) : (
          running.slice(0, 3).map((plugin) => {
            const m = plugin.metrics!;
            return (
              <PanelSectionRow key={plugin.name}>
                <Field
                  focusable
                  highlightOnFocus
                  label={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      {plugin.name}
                      {m.spike && <FaBolt style={{ color: colors.yellow }} />}
                    </span>
                  }
                  description={
                    <div style={{ paddingTop: "4px" }}>
                      <Meter value={m.cpu} peak={m.peakCpu} color={loadColor(m.cpu, 20, 50)} />
                      <div style={{ marginTop: "4px" }}>
                        {m.cpu.toFixed(1)}% CPU · {formatMb(m.memory)}
                      </div>
                    </div>
                  }
                  {...activateHandlers(() => openPlugin(plugin.name))}
                >
                  <FaChevronRight style={{ color: colors.muted }} />
                </Field>
              </PanelSectionRow>
            );
          })
        )}
        {running.length > 3 && (
          <PanelSectionRow>
            <Field focusable highlightOnFocus label={`+${running.length - 3} more running`} {...activateHandlers(() => openPlugin(""))}>
              <FaChevronRight style={{ color: colors.muted }} />
            </Field>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Troubleshooting">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            label="Fresh capture"
            description="Clears every plugin log and resets peaks, then turns live monitoring on. Use it right before reproducing a problem."
            disabled={tm.loading}
            onClick={() =>
              confirmAction({
                title: "Start a fresh capture?",
                description: "This empties the log files of every installed plugin and resets all CPU/RAM peaks.",
                okText: "Clear and start",
                destructive: true,
                onConfirm: () => tm.startFreshCapture(),
              })
            }
          >
            {tm.loading ? "Starting..." : "Start fresh capture"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="About">
        <PanelSectionRow>
          <Field
            focusable
            label="Version"
            description={
              update?.requiresRestart
                ? "Restart pending"
                : update?.hasUpdate
                  ? `Version ${update.latest} is available`
                  : update?.elevated === false
                    ? "Updating needs Decky root permissions"
                    : "Check GitHub for a newer release"
            }
          >
            <span style={{ color: update?.hasUpdate ? colors.green : colors.text }}>{update?.current || "?"}</span>
          </Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonRow style={{ padding: "8px 0" }}>
            <SmallButton icon={<FaSyncAlt />} onClick={() => tm.checkForUpdate()} disabled={!!tm.updating}>
              {tm.updating === "check" ? "Checking..." : "Check"}
            </SmallButton>
            {update?.canInstall && (
              <SmallButton
                icon={<FaDownload />}
                iconColor={update.hasUpdate ? colors.green : undefined}
                onClick={() =>
                  confirmAction({
                    title: update.hasUpdate ? `Install ${update.latest}?` : "Reinstall Task Manager?",
                    description: "Decky Loader restarts afterwards to load the new version.",
                    okText: update.hasUpdate ? "Install" : "Reinstall",
                    onConfirm: () => tm.installUpdate(),
                  })
                }
                disabled={!!tm.updating}
              >
                {tm.updating === "install" ? "Installing..." : update.hasUpdate ? "Install" : "Reinstall"}
              </SmallButton>
            )}
          </ButtonRow>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "11px", color: colors.muted, textAlign: "center", padding: "4px 0 8px" }}>By Yuri</div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
};
