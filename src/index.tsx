import { PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { definePlugin } from "@decky/api";
import { useEffect, useState, FC } from "react";
import { FaTasks } from "react-icons/fa";
import { useTaskManager } from "./useTaskManager";
import { LogsTab } from "./ui/LogsTab";
import { OverviewTab } from "./ui/OverviewTab";
import { PluginsTab } from "./ui/PluginsTab";
import { TabBar } from "./ui/TabBar";
import { colors, severityColor } from "./ui/theme";
import type { Tab } from "./types";

// Module scope so the panel reopens where the user left it
let lastTab: Tab = "overview";

const Dashboard: FC = () => {
  const tm = useTaskManager();
  const [tab, setTabState] = useState<Tab>(lastTab);
  const [expandedPlugin, setExpandedPlugin] = useState<string>();
  const [expandedLog, setExpandedLog] = useState<string>();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const setTab = (next: Tab) => {
    lastTab = next;
    setTabState(next);
  };

  const openPlugin = (name: string) => {
    setExpandedPlugin(name || undefined);
    setTab("plugins");
  };

  const openLogs = (name: string) => {
    setExpandedLog(name);
    setTab("logs");
  };

  if (!tm.snapshot) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ padding: "24px 0", textAlign: "center", color: colors.muted }}>
            {tm.loading || tm.refreshing ? "Reading plugins..." : "Couldn't load plugin data."}
          </div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const plugins = tm.snapshot.plugins;
  const running = plugins.filter((p) => (p.metrics?.processes || 0) > 0).length;
  const errorPlugins = plugins.filter((p) => (p.logs?.errors || 0) > 0 || (p.logs?.alerts?.length || 0) > 0);
  const worst = errorPlugins.some((p) => p.logs?.serious)
    ? severityColor(errorPlugins.some((p) => p.logs?.severity === "critical") ? "critical" : "high")
    : colors.muted;

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <TabBar
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "plugins", label: "Plugins", badge: running, badgeColor: colors.green },
              { id: "logs", label: "Logs", badge: errorPlugins.length, badgeColor: worst },
            ]}
          />
        </PanelSectionRow>
      </PanelSection>

      {tab === "overview" && <OverviewTab tm={tm} now={now} openPlugin={openPlugin} openLogs={openLogs} />}
      {tab === "plugins" && (
        <PluginsTab tm={tm} expanded={expandedPlugin} setExpanded={setExpandedPlugin} openLogs={openLogs} />
      )}
      {tab === "logs" && <LogsTab tm={tm} expanded={expandedLog} setExpanded={setExpandedLog} openPlugin={openPlugin} />}
    </>
  );
};

export default definePlugin(() => ({
  name: "Decky Task Manager",
  titleView: <div className={staticClasses.Title}>Task Manager</div>,
  content: <Dashboard />,
  icon: <FaTasks />,
}));
