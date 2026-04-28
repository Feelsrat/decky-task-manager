import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { CSSProperties, useEffect, useMemo, useState } from "react";
import { FaChartBar, FaSyncAlt, FaTasks } from "react-icons/fa";

type PluginRow = {
  folder: string;
  name: string;
  version: string;
  author: string;
  disabled: boolean;
};

type LogRow = {
  name: string;
  folder: string;
  errors: number;
  files: number;
  examples: string[];
};

type Metrics = {
  cpu: number;
  memory: {
    used: number;
    total: number;
    percent: number;
  };
};

type Snapshot = {
  plugins: PluginRow[];
  logs: {
    plugins: LogRow[];
    totals: {
      errors: number;
      files: number;
    };
  };
  metrics: Metrics;
};

type DisableResult = {
  ok: boolean;
  message: string;
  restarted?: boolean;
};

const getSnapshot = callable<[], Snapshot>("get_snapshot");
const getMetrics = callable<[], Metrics>("get_metrics");
const disablePlugin = callable<[name: string], DisableResult>("disable_plugin");

const styles: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    width: "100%",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    width: "100%",
  },
  muted: {
    opacity: 0.72,
    fontSize: "12px",
    lineHeight: 1.25,
  },
  value: {
    fontSize: "22px",
    fontWeight: 700,
    lineHeight: 1,
  },
  meter: {
    height: "8px",
    width: "100%",
    borderRadius: "4px",
    background: "rgba(255, 255, 255, 0.16)",
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: "4px",
    background: "rgb(93, 188, 210)",
  },
  pluginCard: {
    borderTop: "1px solid rgba(255, 255, 255, 0.12)",
    padding: "10px 0",
  },
  status: {
    minWidth: "78px",
    textAlign: "right",
    fontSize: "12px",
    opacity: 0.8,
  },
  example: {
    opacity: 0.68,
    fontFamily: "monospace",
    fontSize: "11px",
    lineHeight: 1.25,
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
};

function Meter({ value }: { value: number }) {
  return (
    <div style={styles.meter}>
      <div style={{ ...styles.fill, width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function Content() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loading, setLoading] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string>();

  const logRows = useMemo(() => snapshot?.logs.plugins.slice(0, 6) ?? [], [snapshot]);
  const pluginRows = useMemo(() => snapshot?.plugins ?? [], [snapshot]);

  const refresh = async () => {
    setLoading(true);
    try {
      setSnapshot(await getSnapshot());
    } catch (error) {
      toaster.toast({
        title: "Decky Task Manager",
        body: "Could not read Decky status.",
      });
      console.error("[decky-task-manager] refresh failed", error);
    } finally {
      setLoading(false);
    }
  };

  const refreshMetrics = async () => {
    try {
      const metrics = await getMetrics();
      setSnapshot((current) => current ? { ...current, metrics } : current);
    } catch (error) {
      toaster.toast({
        title: "Decky Task Manager",
        body: "Could not read system metrics.",
      });
      console.error("[decky-task-manager] metrics refresh failed", error);
    }
  };

  const onDisable = async (name: string) => {
    setBusyPlugin(name);
    try {
      const result = await disablePlugin(name);
      toaster.toast({
        title: "Decky Task Manager",
        body: result.message,
      });

      if (!result.restarted) {
        await refresh();
      }
    } catch (error) {
      toaster.toast({
        title: "Decky Task Manager",
        body: `Could not disable ${name}.`,
      });
      console.error("[decky-task-manager] disable failed", error);
    } finally {
      setBusyPlugin(undefined);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <>
      <PanelSection title="Plugin Errors">
        <PanelSectionRow>
          <div style={styles.row}>
            <div style={styles.stack}>
              <div style={styles.value}>{snapshot?.logs.totals.errors ?? "-"}</div>
              <div style={styles.muted}>
                errors found across {snapshot?.logs.totals.files ?? 0} log files
              </div>
            </div>
            <ButtonItem
              layout="below"
              disabled={loading}
              onClick={refresh}
            >
              <FaSyncAlt /> {loading ? "Checking" : "Refresh"}
            </ButtonItem>
          </div>
        </PanelSectionRow>

        {logRows.length === 0 && (
          <PanelSectionRow>
            <div style={styles.muted}>No plugin log errors found.</div>
          </PanelSectionRow>
        )}

        {logRows.map((plugin) => (
          <PanelSectionRow key={plugin.name}>
            <div style={{ ...styles.stack, ...styles.pluginCard }}>
              <div style={styles.row}>
                <div>
                  <div>{plugin.name}</div>
                  <div style={styles.muted}>{plugin.files} log file{plugin.files === 1 ? "" : "s"}</div>
                </div>
                <div style={styles.status}>{plugin.errors} error{plugin.errors === 1 ? "" : "s"}</div>
              </div>
              {plugin.examples.slice(0, 2).map((example, index) => (
                <div style={styles.example} key={`${plugin.name}-${index}`}>
                  {example}
                </div>
              ))}
            </div>
          </PanelSectionRow>
        ))}
      </PanelSection>

      <PanelSection title="System and Plugins">
        <PanelSectionRow>
          <div style={styles.stack}>
            <div style={styles.row}>
              <span>CPU</span>
              <span>{snapshot?.metrics.cpu ?? "-"}%</span>
            </div>
            <Meter value={snapshot?.metrics.cpu ?? 0} />
            <div style={styles.row}>
              <span>RAM</span>
              <span>
                {snapshot?.metrics.memory.percent ?? "-"}%
              </span>
            </div>
            <Meter value={snapshot?.metrics.memory.percent ?? 0} />
            <div style={styles.muted}>
              {snapshot?.metrics.memory.used ?? "-"} MB used of {snapshot?.metrics.memory.total ?? "-"} MB
            </div>
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={refreshMetrics}>
            <FaChartBar /> Refresh Metrics
          </ButtonItem>
        </PanelSectionRow>

        {pluginRows.map((plugin) => (
          <PanelSectionRow key={plugin.name}>
            <div style={{ ...styles.row, ...styles.pluginCard }}>
              <div style={styles.stack}>
                <div>{plugin.name}</div>
                <div style={styles.muted}>
                  {plugin.version ? `v${plugin.version}` : plugin.folder}
                  {plugin.disabled ? " · disabled" : ""}
                </div>
              </div>
              <ButtonItem
                layout="below"
                disabled={plugin.disabled || busyPlugin === plugin.name}
                onClick={() => onDisable(plugin.name)}
              >
                {plugin.disabled ? "Disabled" : busyPlugin === plugin.name ? "Disabling" : "Disable"}
              </ButtonItem>
            </div>
          </PanelSectionRow>
        ))}
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  return {
    name: "Decky Task Manager",
    titleView: <div className={staticClasses.Title}>Decky Task Manager</div>,
    content: <Content />,
    icon: <FaTasks />,
    onDismount() {},
  };
});
