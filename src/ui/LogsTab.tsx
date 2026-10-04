import { Field, PanelSection, PanelSectionRow } from "@decky/ui";
import type { FC } from "react";
import { FaCheckCircle, FaChevronDown, FaChevronRight, FaEraser, FaPuzzlePiece, FaSyncAlt } from "react-icons/fa";
import type { TaskManager } from "../useTaskManager";
import type { PluginRow, Severity } from "../types";
import { activateHandlers } from "./activate";
import { ButtonRow, Chip, EmptyState, SmallButton, confirmAction } from "./components";
import { colors, plural, severityColor, severityRank } from "./theme";

const SEVERITIES = ["critical", "high", "medium", "low"] as const satisfies readonly Severity[];

const LogCard: FC<{
  plugin: PluginRow;
  tm: TaskManager;
  expanded: boolean;
  onToggle: () => void;
  openPlugin: (name: string) => void;
}> = ({ plugin, tm, expanded, onToggle, openPlugin }) => {
  const logs = plugin.logs!;
  const severity = logs.severity || "low";
  const issues = logs.knownIssues || [];
  const alerts = logs.alerts || [];
  const groups = logs.groups?.length ? logs.groups : logs.examples.map((message) => ({ message, count: 1, file: "" }));
  const headline = issues[0]?.title || alerts[0]?.title || "Errors in log";

  return (
    <>
      <PanelSectionRow>
        <Field
          focusable
          highlightOnFocus
          bottomSeparator={expanded ? "none" : "standard"}
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
              <Chip color={severityColor(severity)}>{severity}</Chip>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plugin.name}</span>
            </span>
          }
          description={`${headline} · ${plural(logs.errors, "line")}`}
          {...activateHandlers(onToggle)}
        >
          <span style={{ color: colors.muted, display: "flex" }}>{expanded ? <FaChevronDown /> : <FaChevronRight />}</span>
        </Field>
      </PanelSectionRow>
      {expanded && (
        <PanelSectionRow>
          <div style={{ margin: "0 0 10px", padding: "10px", borderRadius: "4px", background: "rgba(255,255,255,0.04)" }}>
            {[...alerts, ...issues].slice(0, 4).map((item) => (
              <div
                key={item.id}
                style={{ borderLeft: `2px solid ${severityColor(item.severity)}`, padding: "2px 0 2px 8px", marginBottom: "8px" }}
              >
                <div style={{ fontSize: "13px", fontWeight: 600, color: colors.text }}>
                  {item.title}
                  {"count" in item && <span style={{ color: colors.muted, fontWeight: 400 }}> ×{item.count}</span>}
                </div>
                <div style={{ fontSize: "11px", color: colors.muted }}>{"advice" in item ? item.advice : item.message}</div>
              </div>
            ))}

            {groups.length > 0 && (
              <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: colors.muted, margin: "4px 0 6px" }}>
                Most frequent lines
              </div>
            )}
            {groups.slice(0, 3).map((group, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "6px",
                  alignItems: "flex-start",
                  marginBottom: "6px",
                  padding: "6px",
                  borderRadius: "3px",
                  background: "rgba(0,0,0,0.25)",
                }}
              >
                <span style={{ fontSize: "10px", fontWeight: 700, color: colors.muted, minWidth: "24px", paddingTop: "1px" }}>
                  ×{group.count}
                </span>
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: "10px",
                    lineHeight: 1.35,
                    color: colors.text,
                    wordBreak: "break-word",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {group.message}
                </span>
              </div>
            ))}

            {logs.rate?.active && (
              <div style={{ fontSize: "11px", color: colors.yellow, margin: "4px 0" }}>
                Writing {logs.rate.linesPerSecond.toFixed(1)} lines/s ({(logs.rate.bytesPerSecond / 1024).toFixed(1)} KB/s)
              </div>
            )}

            <ButtonRow style={{ marginTop: "8px" }}>
              <SmallButton
                icon={<FaEraser />}
                onClick={() => tm.clearLogs(plugin.name)}
                disabled={tm.clearingLogs !== undefined}
              >
                {tm.clearingLogs === plugin.name ? "Clearing..." : "Clear log"}
              </SmallButton>
              <SmallButton icon={<FaPuzzlePiece />} onClick={() => openPlugin(plugin.name)}>
                Plugin
              </SmallButton>
            </ButtonRow>
          </div>
        </PanelSectionRow>
      )}
    </>
  );
};

export const LogsTab: FC<{
  tm: TaskManager;
  expanded?: string;
  setExpanded: (name?: string) => void;
  openPlugin: (name: string) => void;
}> = ({ tm, expanded, setExpanded, openPlugin }) => {
  const totals = tm.snapshot?.logs.totals;
  const affected = (tm.snapshot?.plugins || [])
    .filter((p) => (p.logs?.errors || 0) > 0 || (p.logs?.alerts?.length || 0) > 0)
    .sort(
      (a, b) =>
        severityRank[b.logs?.severity || "info"] - severityRank[a.logs?.severity || "info"] ||
        (b.logs?.errors || 0) - (a.logs?.errors || 0),
    );

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <div style={{ padding: "4px 2px 8px" }}>
            <div style={{ fontSize: "13px", color: colors.text }}>
              {plural(totals?.errors || 0, "error line")} across {plural(totals?.files || 0, "log file")}
            </div>
            {affected.length > 0 && (
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                {SEVERITIES.filter((s) => (totals?.[s] || 0) > 0).map((s) => (
                  <Chip key={s} color={severityColor(s)}>
                    {totals?.[s]} {s}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonRow style={{ paddingBottom: "8px" }}>
            <SmallButton icon={<FaSyncAlt />} onClick={() => tm.refresh()} disabled={tm.refreshing}>
              {tm.refreshing ? "Scanning..." : "Rescan"}
            </SmallButton>
            <SmallButton
              icon={<FaEraser />}
              disabled={tm.clearingLogs !== undefined || !totals?.files}
              onClick={() =>
                confirmAction({
                  title: "Clear all plugin logs?",
                  description: "Every installed plugin's log files are emptied. This can't be undone.",
                  okText: "Clear all",
                  destructive: true,
                  onConfirm: () => tm.clearLogs(),
                })
              }
            >
              {tm.clearingLogs === true ? "Clearing..." : "Clear all"}
            </SmallButton>
          </ButtonRow>
        </PanelSectionRow>
      </PanelSection>

      {affected.length === 0 ? (
        <PanelSection>
          <PanelSectionRow>
            <EmptyState icon={<FaCheckCircle />} title="No errors in plugin logs" body="Recent log output looks clean." />
          </PanelSectionRow>
        </PanelSection>
      ) : (
        <PanelSection title={`Plugins with errors (${affected.length})`}>
          {affected.map((plugin) => (
            <LogCard
              key={plugin.name}
              plugin={plugin}
              tm={tm}
              expanded={expanded === plugin.name}
              onToggle={() => setExpanded(expanded === plugin.name ? undefined : plugin.name)}
              openPlugin={openPlugin}
            />
          ))}
        </PanelSection>
      )}
    </>
  );
};
