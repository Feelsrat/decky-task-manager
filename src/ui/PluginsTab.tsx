import { Field, PanelSection, PanelSectionRow } from "@decky/ui";
import type { FC, ReactNode } from "react";
import { FaBan, FaBolt, FaChevronDown, FaChevronRight, FaFileAlt, FaPlay, FaPuzzlePiece, FaStop } from "react-icons/fa";
import type { TaskManager } from "../useTaskManager";
import type { PluginRow } from "../types";
import { activateHandlers } from "./activate";
import { ButtonRow, Chip, Dot, EmptyState, Meter, SmallButton, confirmAction } from "./components";
import { SELF_NAME, colors, formatMb, loadColor, plural, severityColor } from "./theme";

type Status = "running" | "idle" | "disabled";

function statusOf(plugin: PluginRow): Status {
  if ((plugin.metrics?.processes || 0) > 0) return "running";
  return plugin.disabled ? "disabled" : "idle";
}

const statusColor: Record<Status, string> = {
  running: colors.green,
  idle: colors.muted,
  disabled: colors.red,
};

const MetricLine: FC<{ label: string; value: string; peak: string; percent: number; peakPercent: number; color: string }> = ({
  label,
  value,
  peak,
  percent,
  peakPercent,
  color,
}) => (
  <div style={{ marginBottom: "8px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
      <span style={{ color: colors.muted }}>{label}</span>
      <span>
        <span style={{ color: colors.text, fontWeight: 600 }}>{value}</span>
        <span style={{ color: colors.muted }}> · peak {peak}</span>
      </span>
    </div>
    <Meter value={percent} peak={peakPercent} color={color} height={6} />
  </div>
);

const Detail: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", padding: "2px 0" }}>
    <span style={{ color: colors.muted }}>{label}</span>
    <span style={{ color: colors.text, textAlign: "right" }}>{children}</span>
  </div>
);

const PluginCard: FC<{
  plugin: PluginRow;
  tm: TaskManager;
  expanded: boolean;
  totalMemory: number;
  onToggle: () => void;
  openLogs: (name: string) => void;
}> = ({ plugin, tm, expanded, totalMemory, onToggle, openLogs }) => {
  const status = statusOf(plugin);
  const m = plugin.metrics;
  const errors = plugin.logs?.errors || 0;
  const isSelf = plugin.name === SELF_NAME;
  const busy = tm.busyPlugin === plugin.name || tm.killingPlugin === plugin.name;

  const summary =
    status === "running" && m
      ? `${m.cpu.toFixed(1)}% CPU · ${formatMb(m.memory)}`
      : status === "disabled"
        ? "Disabled"
        : "Not running";

  const toggle = () => {
    if (plugin.disabled) {
      tm.togglePlugin(plugin.name, true);
      return;
    }
    confirmAction({
      title: `Disable ${plugin.name}?`,
      description: "Decky Loader restarts to apply this. You can enable it again from this list.",
      okText: "Disable",
      destructive: true,
      onConfirm: () => tm.togglePlugin(plugin.name, false),
    });
  };

  const stop = () =>
    confirmAction({
      title: `Stop ${plugin.name}?`,
      description:
        "Its backend processes are terminated now. The plugin stays enabled and starts again the next time Decky Loader restarts.",
      okText: "Stop processes",
      destructive: true,
      onConfirm: () => tm.killPlugin(plugin.name),
    });

  return (
    <>
      <PanelSectionRow>
        <Field
          focusable
          highlightOnFocus
          bottomSeparator={expanded ? "none" : "standard"}
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
              <Dot color={statusColor[status]} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plugin.name}</span>
              {m?.spike && <FaBolt style={{ color: colors.yellow, minWidth: "12px" }} />}
            </span>
          }
          description={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              {summary}
              {errors > 0 && (
                <Chip color={severityColor(plugin.logs?.severity || "low")}>{plural(errors, "error")}</Chip>
              )}
            </span>
          }
          {...activateHandlers(onToggle)}
        >
          <span style={{ color: colors.muted, display: "flex" }}>{expanded ? <FaChevronDown /> : <FaChevronRight />}</span>
        </Field>
      </PanelSectionRow>
      {expanded && (
        <PanelSectionRow>
          <div
            style={{
              margin: "0 0 10px",
              padding: "10px",
              borderRadius: "4px",
              background: colors.card,
            }}
          >
            {status === "running" && m && (
              <>
                <MetricLine
                  label="CPU"
                  value={`${m.cpu.toFixed(1)}%`}
                  peak={`${m.peakCpu.toFixed(1)}%`}
                  percent={m.cpu}
                  peakPercent={m.peakCpu}
                  color={loadColor(m.cpu, 20, 50)}
                />
                <MetricLine
                  label="RAM"
                  value={formatMb(m.memory)}
                  peak={formatMb(m.peakMemory)}
                  percent={totalMemory ? (m.memory / totalMemory) * 100 : 0}
                  peakPercent={totalMemory ? (m.peakMemory / totalMemory) * 100 : 0}
                  color={colors.green}
                />
              </>
            )}
            {plugin.version && <Detail label="Version">{plugin.version}</Detail>}
            {plugin.author && <Detail label="Author">{plugin.author}</Detail>}
            {status === "running" && m && <Detail label="Processes">{m.processes}</Detail>}
            <Detail label="Log errors">{errors}</Detail>
            {m?.spike && (
              <Detail label="Spike">
                <span style={{ color: colors.yellow }}>{m.spikeReason === "ram" ? "RAM jump" : "High CPU"}</span>
              </Detail>
            )}

            {isSelf ? (
              <div style={{ fontSize: "11px", color: colors.muted, marginTop: "8px" }}>
                This is Task Manager itself, so it can't be disabled or stopped from here.
              </div>
            ) : (
              <ButtonRow style={{ marginTop: "10px" }}>
                <SmallButton
                  icon={plugin.disabled ? <FaPlay /> : <FaBan />}
                  iconColor={plugin.disabled ? colors.green : colors.orange}
                  onClick={toggle}
                  disabled={busy}
                >
                  {tm.busyPlugin === plugin.name ? "Working..." : plugin.disabled ? "Enable" : "Disable"}
                </SmallButton>
                {status === "running" && (
                  <SmallButton icon={<FaStop />} iconColor={colors.red} onClick={stop} disabled={busy}>
                    {tm.killingPlugin === plugin.name ? "Stopping..." : "Stop"}
                  </SmallButton>
                )}
                {errors > 0 && (
                  <SmallButton icon={<FaFileAlt />} onClick={() => openLogs(plugin.name)}>
                    Logs
                  </SmallButton>
                )}
              </ButtonRow>
            )}
          </div>
        </PanelSectionRow>
      )}
    </>
  );
};

export const PluginsTab: FC<{
  tm: TaskManager;
  expanded?: string;
  setExpanded: (name?: string) => void;
  openLogs: (name: string) => void;
}> = ({ tm, expanded, setExpanded, openLogs }) => {
  const plugins = tm.snapshot?.plugins || [];
  const totalMemory = tm.snapshot?.metrics.memory.total || 0;

  if (plugins.length === 0) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <EmptyState icon={<FaPuzzlePiece />} color={colors.muted} title="No plugins found" body="Install plugins from the Decky store." />
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const groups: { status: Status; title: string; rows: PluginRow[] }[] = [
    {
      status: "running",
      title: "Running",
      rows: plugins
        .filter((p) => statusOf(p) === "running")
        .sort((a, b) => (b.metrics?.cpu || 0) - (a.metrics?.cpu || 0) || (b.metrics?.memory || 0) - (a.metrics?.memory || 0)),
    },
    { status: "idle", title: "Idle", rows: plugins.filter((p) => statusOf(p) === "idle") },
    { status: "disabled", title: "Disabled", rows: plugins.filter((p) => statusOf(p) === "disabled") },
  ];

  return (
    <>
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <PanelSection key={group.status} title={`${group.title} (${group.rows.length})`}>
            {group.rows.map((plugin) => (
              <PluginCard
                key={plugin.name}
                plugin={plugin}
                tm={tm}
                totalMemory={totalMemory}
                expanded={expanded === plugin.name}
                onToggle={() => setExpanded(expanded === plugin.name ? undefined : plugin.name)}
                openLogs={openLogs}
              />
            ))}
          </PanelSection>
        ))}
      <PanelSection>
        <PanelSectionRow>
          <div style={{ fontSize: "11px", color: colors.muted, padding: "0 2px 8px" }}>
            Idle plugins have no backend process running. Most frontend-only plugins always show as idle.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
};
