/**
 * Browser stand-ins for the @decky/ui components this plugin uses, styled to approximate the
 * Steam Deck Quick Access Menu. Only for the local preview: on a Deck the real components
 * (and Steam's own CSS) are used instead.
 *
 * Gamepad navigation is modelled with data attributes read by preview/nav.ts:
 *   data-nav-leaf  - something that can take focus
 *   data-nav-flow  - a container; "horizontal" lets Left/Right move between its children,
 *                    anything else only moves Up/Down (Steam's default)
 */
import { createContext, useContext, useState } from "react";
import type { CSSProperties, FC, ReactNode } from "react";
import { closeTopModal, openModal } from "../modalHost";

type Activate = (() => void) | undefined;

function leafProps(onActivate: Activate, disabled?: boolean) {
  return {
    "data-nav-leaf": disabled ? undefined : "",
    "data-disabled": disabled ? "" : undefined,
    onClick: disabled ? undefined : onActivate,
  };
}

export const staticClasses = { Title: "mock-title" };

export const PanelSection: FC<{ title?: string; spinner?: boolean; children?: ReactNode }> = ({ title, children }) => (
  <div className="mock-panel-section">
    {title && <div className="mock-panel-section-title">{title}</div>}
    {children}
  </div>
);

export const PanelSectionRow: FC<{ children?: ReactNode }> = ({ children }) => (
  <div className="mock-panel-row">{children}</div>
);

type FocusableProps = {
  children?: ReactNode;
  "flow-children"?: string;
  style?: CSSProperties;
  className?: string;
  focusClassName?: string;
  onActivate?: (e: any) => void;
  onClick?: (e: any) => void;
  onCancel?: (e: any) => void;
  [key: string]: unknown;
};

export const Focusable: FC<FocusableProps> = ({
  children,
  "flow-children": flow,
  style,
  className,
  onActivate,
  onClick,
  focusClassName: _focusClassName,
  onCancel: _onCancel,
  ...rest
}) => {
  const handler = onActivate || onClick;
  if (handler) {
    return (
      <div className={className} style={style} {...leafProps(() => handler({}))} {...domSafe(rest)}>
        {children}
      </div>
    );
  }
  return (
    <div className={className} style={style} data-nav-flow={flow || "vertical"} {...domSafe(rest)}>
      {children}
    </div>
  );
};

function domSafe(props: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("aria-") || key === "role" || key === "title") out[key] = value;
  }
  return out;
}

type DialogButtonProps = {
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  disabled?: boolean;
  onClick?: (e: any) => void;
  [key: string]: unknown;
};

export const DialogButton: FC<DialogButtonProps> = ({ children, style, className, disabled, onClick, ...rest }) => (
  <button
    type="button"
    className={`mock-dialog-button ${className || ""}`}
    style={style}
    disabled={disabled}
    {...leafProps(onClick ? () => onClick({}) : undefined, disabled)}
    {...domSafe(rest)}
  >
    {children}
  </button>
);

export const DialogButtonPrimary = DialogButton;
export const DialogButtonSecondary = DialogButton;

type FieldProps = {
  children?: ReactNode;
  label?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  bottomSeparator?: "standard" | "thick" | "none";
  focusable?: boolean;
  highlightOnFocus?: boolean;
  disabled?: boolean;
  childrenLayout?: "below" | "inline";
  onActivate?: (e: any) => void;
  onClick?: (e: any) => void;
  [key: string]: unknown;
};

export const Field: FC<FieldProps> = ({
  children,
  label,
  description,
  icon,
  bottomSeparator = "standard",
  focusable,
  highlightOnFocus = true,
  childrenLayout,
  onActivate,
  onClick,
}) => {
  const handler = onActivate || onClick;
  const isLeaf = focusable || !!handler;
  return (
    <div
      className={`mock-field sep-${bottomSeparator} ${highlightOnFocus ? "highlight" : ""}`}
      {...(isLeaf ? leafProps(handler ? () => handler({}) : () => undefined) : {})}
    >
      <div className={`mock-field-main ${childrenLayout === "below" ? "below" : ""}`}>
        {(label || icon) && (
          <div className="mock-field-label">
            {icon}
            {label}
          </div>
        )}
        {children !== undefined && <div className="mock-field-children">{children}</div>}
      </div>
      {description && <div className="mock-field-description">{description}</div>}
    </div>
  );
};

type ItemProps = {
  children?: ReactNode;
  label?: ReactNode;
  description?: ReactNode;
  layout?: "below" | "inline";
  disabled?: boolean;
  bottomSeparator?: "standard" | "thick" | "none";
};

export const ButtonItem: FC<ItemProps & { onClick?: (e: any) => void }> = ({
  children,
  label,
  description,
  layout,
  disabled,
  onClick,
  bottomSeparator = "standard",
}) => (
  <div className={`mock-field sep-${bottomSeparator}`}>
    {label && (
      <div className="mock-field-main">
        <div className="mock-field-label">{label}</div>
      </div>
    )}
    {description && <div className="mock-field-description">{description}</div>}
    <button
      type="button"
      className={`mock-dialog-button ${layout === "below" ? "full" : ""}`}
      disabled={disabled}
      style={{ marginTop: label || description ? "8px" : 0 }}
      {...leafProps(onClick ? () => onClick({}) : undefined, disabled)}
    >
      {children}
    </button>
  </div>
);

export const ToggleField: FC<ItemProps & { checked: boolean; onChange?: (checked: boolean) => void }> = ({
  label,
  description,
  checked,
  disabled,
  onChange,
}) => (
  <div className="mock-field sep-standard highlight" {...leafProps(() => onChange?.(!checked), disabled)}>
    <div className="mock-field-main">
      <div className="mock-field-label">{label}</div>
      <div className="mock-field-children">
        <div className={`mock-toggle ${checked ? "on" : ""}`}>
          <div className="mock-toggle-knob" />
        </div>
      </div>
    </div>
    {description && <div className="mock-field-description">{description}</div>}
  </div>
);

export const ProgressBar: FC<{ nProgress?: number }> = ({ nProgress = 0 }) => (
  <div style={{ height: 4, background: "rgba(255,255,255,.1)" }}>
    <div style={{ width: `${nProgress}%`, height: "100%", background: "#1a9fff" }} />
  </div>
);

export const Spinner: FC = () => <span>…</span>;

const ModalCloseContext = createContext<() => void>(() => undefined);

export const ConfirmModal: FC<{
  strTitle?: ReactNode;
  strDescription?: ReactNode;
  strOKButtonText?: ReactNode;
  strCancelButtonText?: ReactNode;
  bDestructiveWarning?: boolean;
  onOK?: () => void;
  onCancel?: () => void;
  closeModal?: () => void;
}> = ({ strTitle, strDescription, strOKButtonText = "Confirm", strCancelButtonText = "Cancel", bDestructiveWarning, onOK, onCancel }) => {
  const close = useContext(ModalCloseContext);
  const [done, setDone] = useState(false);
  const finish = (fn?: () => void) => {
    if (done) return;
    setDone(true);
    close();
    fn?.();
  };
  return (
    <div className="mock-modal">
      <div className="mock-modal-title">{strTitle}</div>
      <div className="mock-modal-body">{strDescription}</div>
      <div className="mock-modal-buttons" data-nav-flow="horizontal">
        <button
          type="button"
          className={`mock-dialog-button ${bDestructiveWarning ? "destructive" : "primary"}`}
          {...leafProps(() => finish(onOK))}
        >
          {strOKButtonText}
        </button>
        <button type="button" className="mock-dialog-button" {...leafProps(() => finish(onCancel))}>
          {strCancelButtonText}
        </button>
      </div>
    </div>
  );
};

export function showModal(modal: ReactNode) {
  const id = openModal((close) => <ModalCloseContext.Provider value={close}>{modal}</ModalCloseContext.Provider>);
  return { Close: () => closeTopModal(id), Update: () => undefined };
}
