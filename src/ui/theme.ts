import type { Severity } from "../types";

export const SELF_NAME = "Decky Task Manager";

export const colors = {
  text: "#dcdedf",
  muted: "#8b929a",
  faint: "rgba(255,255,255,0.08)",
  track: "rgba(255,255,255,0.10)",
  card: "rgba(255,255,255,0.04)",
  blue: "#1a9fff",
  green: "#59bf40",
  yellow: "#e8b625",
  orange: "#ff8a3d",
  red: "#ff5f57",
};

export const severityRank: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityColor(severity: Severity = "info") {
  switch (severity) {
    case "critical":
      return colors.red;
    case "high":
      return colors.orange;
    case "medium":
      return colors.yellow;
    case "low":
      return "#8ab4f8";
    default:
      return colors.muted;
  }
}

/** Colour for a 0-100 load value: calm until it starts to matter. */
export function loadColor(percent: number, warnAt = 60, dangerAt = 85) {
  if (percent >= dangerAt) return colors.red;
  if (percent >= warnAt) return colors.yellow;
  return colors.blue;
}

export function formatMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatAge(timestamp: number | undefined, now: number) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round(now / 1000 - timestamp));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function plural(count: number, word: string, suffix = "s") {
  return `${count} ${word}${count === 1 ? "" : suffix}`;
}
