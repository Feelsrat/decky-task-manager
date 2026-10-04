import { DialogButton } from "@decky/ui";
import type { FC } from "react";
import { ButtonRow } from "./components";
import { colors } from "./theme";
import type { Tab } from "../types";

type TabSpec = { id: Tab; label: string; badge?: number; badgeColor?: string };

export const TabBar: FC<{ tabs: TabSpec[]; active: Tab; onChange: (tab: Tab) => void }> = ({
  tabs,
  active,
  onChange,
}) => (
  <ButtonRow style={{ gap: "4px", padding: "4px 0 8px" }}>
    {tabs.map((tab) => {
      const selected = tab.id === active;
      return (
        <DialogButton
          key={tab.id}
          onClick={() => onChange(tab.id)}
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            width: "auto",
            height: "34px",
            padding: "0 4px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "5px",
            fontSize: "13px",
            fontWeight: selected ? 700 : 400,
            opacity: selected ? 1 : 0.75,
          }}
        >
          {tab.label}
          {!!tab.badge && (
            <span
              style={{
                minWidth: "16px",
                height: "16px",
                padding: "0 4px",
                borderRadius: "8px",
                fontSize: "10px",
                fontWeight: 700,
                lineHeight: "16px",
                color: "#0e141b",
                background: tab.badgeColor || colors.muted,
              }}
            >
              {tab.badge > 99 ? "99+" : tab.badge}
            </span>
          )}
          {selected && (
            <span
              style={{
                position: "absolute",
                left: "20%",
                right: "20%",
                bottom: "3px",
                height: "2px",
                borderRadius: "2px",
                background: colors.blue,
              }}
            />
          )}
        </DialogButton>
      );
    })}
  </ButtonRow>
);
