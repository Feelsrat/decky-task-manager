import { ConfirmModal, DialogButton, Focusable, showModal } from "@decky/ui";
import type { CSSProperties, FC, ReactNode } from "react";
import { colors } from "./theme";

export function withAlpha(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const Chip: FC<{ color: string; children: ReactNode; solid?: boolean }> = ({ color, children, solid }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "1px 6px",
      borderRadius: "3px",
      fontSize: "10px",
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      lineHeight: "16px",
      whiteSpace: "nowrap",
      color: solid ? "#0e141b" : color,
      background: solid ? color : withAlpha(color, 0.16),
    }}
  >
    {children}
  </span>
);

export const Dot: FC<{ color: string; pulse?: boolean }> = ({ color }) => (
  <span
    style={{
      display: "inline-block",
      width: "8px",
      height: "8px",
      minWidth: "8px",
      borderRadius: "50%",
      background: color,
      boxShadow: `0 0 0 3px ${withAlpha(color, 0.18)}`,
    }}
  />
);

export const Meter: FC<{ value: number; peak?: number; color: string; height?: number }> = ({
  value,
  peak,
  color,
  height = 4,
}) => {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return (
    <div
      style={{
        position: "relative",
        height: `${height}px`,
        borderRadius: `${height}px`,
        background: colors.track,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${clamp(value)}%`,
          background: color,
          borderRadius: `${height}px`,
          transition: "width 0.4s ease",
        }}
      />
      {peak !== undefined && peak > value && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `calc(${clamp(peak)}% - 2px)`,
            width: "2px",
            background: withAlpha(color, 0.7),
          }}
        />
      )}
    </div>
  );
};

export const Sparkline: FC<{ values: number[]; color: string; max?: number; height?: number }> = ({
  values,
  color,
  max = 100,
  height = 28,
}) => {
  const width = 100;
  if (values.length < 2) {
    return <div style={{ height: `${height}px`, borderBottom: `1px dashed ${colors.track}` }} />;
  }

  const top = Math.max(max, ...values) || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(height - (v / top) * (height - 2) - 1).toFixed(2)}`);
  const line = points.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: `${height}px`, display: "block" }}
    >
      <polygon points={area} fill={withAlpha(color, 0.16)} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export const StatTile: FC<{
  label: string;
  value: string;
  sub: string;
  color: string;
  history: number[];
}> = ({ label, value, sub, color, history }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      padding: "10px 10px 8px",
      borderRadius: "4px",
      background: colors.card,
    }}
  >
    <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: colors.muted }}>
      {label}
    </div>
    <div style={{ fontSize: "22px", fontWeight: 700, color, lineHeight: "28px" }}>{value}</div>
    <div style={{ fontSize: "11px", color: colors.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {sub}
    </div>
    <div style={{ marginTop: "6px" }}>
      <Sparkline values={history} color={color} />
    </div>
  </div>
);

/** A row of buttons the D-pad can move left/right across. */
export const ButtonRow: FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <Focusable
    flow-children="horizontal"
    style={{ display: "flex", gap: "6px", width: "100%", ...style }}
  >
    {children}
  </Focusable>
);

const compactButton: CSSProperties = {
  minWidth: 0,
  width: "auto",
  flex: 1,
  height: "34px",
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
  fontSize: "13px",
  whiteSpace: "nowrap",
};

/**
 * Compact DialogButton. Colours go on the icon only: an inline background or text colour
 * would override Steam's focus highlight and make the focused button unreadable.
 */
export const SmallButton: FC<{
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  iconColor?: string;
  label?: string;
  children?: ReactNode;
  grow?: number;
}> = ({ onClick, disabled, icon, iconColor, label, children, grow = 1 }) => (
  <DialogButton
    style={{ ...compactButton, flex: grow }}
    disabled={disabled}
    onClick={() => onClick()}
    aria-label={label}
  >
    {icon && <span style={{ display: "flex", color: iconColor }}>{icon}</span>}
    {children}
  </DialogButton>
);

export const EmptyState: FC<{ icon: ReactNode; title: string; body?: string; color?: string }> = ({
  icon,
  title,
  body,
  color = colors.green,
}) => (
  <div style={{ padding: "18px 8px", textAlign: "center" }}>
    <div style={{ fontSize: "26px", color, display: "flex", justifyContent: "center" }}>{icon}</div>
    <div style={{ marginTop: "8px", fontWeight: 600, color: colors.text }}>{title}</div>
    {body && <div style={{ marginTop: "4px", fontSize: "12px", color: colors.muted }}>{body}</div>}
  </div>
);

export function confirmAction(options: {
  title: string;
  description: ReactNode;
  okText: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  showModal(
    <ConfirmModal
      strTitle={options.title}
      strDescription={options.description}
      strOKButtonText={options.okText}
      bDestructiveWarning={options.destructive}
      onOK={options.onConfirm}
    />,
  );
}
