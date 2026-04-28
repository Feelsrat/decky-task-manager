import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import decky


ERROR_PATTERN = re.compile(
    r"\b(error|exception|traceback|critical|fatal|failed|failure)\b",
    re.IGNORECASE,
)
MAX_LOG_BYTES = 512 * 1024
HISTORY_LIMIT = 60
SYSTEM_CPU_SPIKE = 85.0
PLUGIN_CPU_SPIKE = 20.0
PLUGIN_MEMORY_SPIKE_MB = 250


class Plugin:
    def __init__(self):
        self._previous_cpu: tuple[int, int] | None = None
        self._previous_processes: dict[int, int] = {}
        self._history: list[dict[str, Any]] = []

    async def _main(self):
        decky.logger.info("Decky Task Manager loaded")

    async def _unload(self):
        decky.logger.info("Decky Task Manager unloaded")

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass

    async def get_snapshot(self) -> dict[str, Any]:
        plugins = self._list_plugins()
        logs = self._scan_logs(plugins)
        metrics = await self.get_metrics()

        return {
            "plugins": self._merge_plugin_data(plugins, logs, metrics),
            "logs": logs,
            "metrics": metrics,
        }

    async def get_metrics(self) -> dict[str, Any]:
        first = self._read_cpu_times()
        if self._previous_cpu is None:
            await asyncio.sleep(0.15)
            first = self._read_cpu_times()

        processes = self._read_plugin_processes(self._list_plugins())
        now = time.time()
        metrics = {
            "timestamp": now,
            "cpu": self._cpu_percent(self._previous_cpu or first, first),
            "memory": self._read_memory(),
            "plugins": self._plugin_metrics(processes, first),
        }

        self._previous_cpu = first
        self._previous_processes = {
            process["pid"]: process["cpu_time"] for process in processes
        }
        self._remember(metrics)
        return metrics

    async def clear_logs(self, name: str | None = None) -> dict[str, Any]:
        plugins = self._list_plugins()
        wanted = {name} if name else {plugin["name"] for plugin in plugins}
        cleared = 0
        failed = 0

        for plugin in plugins:
            if plugin["name"] not in wanted:
                continue

            for log_path in self._log_paths_for_plugin(Path(decky.DECKY_HOME) / "logs", plugin):
                try:
                    log_path.write_text("", encoding="utf-8")
                    cleared += 1
                except OSError:
                    failed += 1

        return {
            "ok": failed == 0,
            "cleared": cleared,
            "failed": failed,
            "message": f"Cleared {cleared} log file{'s' if cleared != 1 else ''}.",
        }

    async def disable_plugin(self, name: str) -> dict[str, Any]:
        plugins = self._list_plugins()
        valid_names = {plugin["name"] for plugin in plugins}

        if name == "Decky Task Manager":
            return {"ok": False, "message": "Decky Task Manager cannot disable itself."}

        if name not in valid_names:
            return {"ok": False, "message": f"{name} was not found."}

        settings_path = Path(decky.DECKY_HOME) / "settings" / "loader.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)

        settings: dict[str, Any] = {}
        if settings_path.exists():
            try:
                settings = json.loads(settings_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                backup_path = settings_path.with_suffix(".json.bak")
                backup_path.write_text(settings_path.read_text(encoding="utf-8"), encoding="utf-8")
                decky.logger.warning("Backed up unreadable loader settings to %s", backup_path)

        disabled_plugins = settings.get("disabled_plugins", [])
        if not isinstance(disabled_plugins, list):
            disabled_plugins = []

        if name not in disabled_plugins:
            disabled_plugins.append(name)

        settings["disabled_plugins"] = disabled_plugins
        settings_path.write_text(json.dumps(settings, indent=4), encoding="utf-8")

        restarted = self._schedule_loader_restart()
        return {
            "ok": True,
            "message": f"{name} is disabled.",
            "restarted": restarted,
        }

    def _merge_plugin_data(
        self,
        plugins: list[dict[str, Any]],
        logs: dict[str, Any],
        metrics: dict[str, Any],
    ) -> list[dict[str, Any]]:
        log_map = {row["name"]: row for row in logs["plugins"]}
        metric_map = {row["name"]: row for row in metrics["plugins"]}
        rows: list[dict[str, Any]] = []

        for plugin in plugins:
            rows.append(
                {
                    **plugin,
                    "logs": log_map.get(plugin["name"], {}),
                    "metrics": metric_map.get(plugin["name"], {}),
                }
            )

        return rows

    def _list_plugins(self) -> list[dict[str, Any]]:
        plugin_dir = Path(decky.DECKY_HOME) / "plugins"
        disabled = self._disabled_plugins()
        plugins: list[dict[str, Any]] = []

        if not plugin_dir.exists():
            return plugins

        for folder in sorted(plugin_dir.iterdir(), key=lambda item: item.name.lower()):
            manifest_path = folder / "plugin.json"
            if not folder.is_dir() or not manifest_path.exists():
                continue

            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue

            package_version = self._package_version(folder / "package.json")
            name = str(manifest.get("name") or folder.name)

            plugins.append(
                {
                    "folder": folder.name,
                    "name": name,
                    "version": package_version,
                    "author": manifest.get("author", ""),
                    "disabled": name in disabled,
                }
            )

        return plugins

    def _scan_logs(self, plugins: list[dict[str, Any]]) -> dict[str, Any]:
        log_root = Path(decky.DECKY_HOME) / "logs"
        plugin_rows: list[dict[str, Any]] = []
        totals = {"errors": 0, "files": 0}

        for plugin in plugins:
            paths = self._log_paths_for_plugin(log_root, plugin)
            errors = 0
            examples: list[str] = []
            grouped: dict[str, dict[str, Any]] = {}

            for log_path in paths:
                lines = self._tail_lines(log_path)
                file_errors = [line.strip() for line in lines if ERROR_PATTERN.search(line)]
                errors += len(file_errors)
                totals["files"] += 1

                for line in file_errors:
                    key = self._normalize_error(line)
                    current = grouped.setdefault(
                        key,
                        {
                            "message": line[-260:],
                            "count": 0,
                            "file": str(log_path.relative_to(log_root)),
                        },
                    )
                    current["count"] += 1

                for line in file_errors[-3:]:
                    if len(examples) < 3:
                        examples.append(line[-220:])

            totals["errors"] += errors
            plugin_rows.append(
                {
                    "name": plugin["name"],
                    "folder": plugin["folder"],
                    "errors": errors,
                    "files": len(paths),
                    "examples": examples,
                    "groups": sorted(grouped.values(), key=lambda item: (-item["count"], item["message"].lower())),
                }
            )

        plugin_rows.sort(key=lambda item: (-item["errors"], item["name"].lower()))
        return {"plugins": plugin_rows, "totals": totals}

    def _log_paths_for_plugin(self, log_root: Path, plugin: dict[str, Any]) -> list[Path]:
        if not log_root.exists():
            return []

        names = {
            str(plugin["folder"]).lower(),
            str(plugin["name"]).lower(),
            str(plugin["name"]).lower().replace(" ", "-"),
            str(plugin["name"]).lower().replace(" ", "_"),
        }
        paths: list[Path] = []

        for candidate in log_root.rglob("*"):
            if not candidate.is_file():
                continue

            lowered = str(candidate.relative_to(log_root)).lower()
            if any(name and name in lowered for name in names):
                paths.append(candidate)

        return sorted(paths)

    def _tail_lines(self, path: Path) -> list[str]:
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(size - MAX_LOG_BYTES, 0))
                data = handle.read()
        except OSError:
            return []

        return data.decode("utf-8", errors="replace").splitlines()

    def _normalize_error(self, line: str) -> str:
        clean = re.sub(r"\d{4}-\d{2}-\d{2}[tT ][\d:.+-]+", "", line)
        clean = re.sub(r"\b\d+\b", "#", clean)
        clean = re.sub(r"0x[0-9a-fA-F]+", "0x#", clean)
        clean = re.sub(r"\s+", " ", clean)
        return clean.strip().lower()[-220:]

    def _read_cpu_times(self) -> tuple[int, int]:
        try:
            with open("/proc/stat", "r", encoding="utf-8") as proc_stat:
                fields = proc_stat.readline().split()[1:]
        except OSError:
            return (0, 0)

        values = [int(value) for value in fields]
        idle = values[3] + values[4]
        total = sum(values)
        return (idle, total)

    def _read_plugin_processes(self, plugins: list[dict[str, Any]]) -> list[dict[str, Any]]:
        plugin_names = {plugin["name"]: plugin for plugin in plugins}
        plugin_folders = {plugin["folder"]: plugin for plugin in plugins}
        processes: list[dict[str, Any]] = []

        for proc_path in Path("/proc").iterdir():
            if not proc_path.name.isdigit():
                continue

            try:
                stat = (proc_path / "stat").read_text(encoding="utf-8")
                status = (proc_path / "status").read_text(encoding="utf-8")
                cmdline = (proc_path / "cmdline").read_text(encoding="utf-8", errors="replace")
                environ = (proc_path / "environ").read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            plugin = self._process_plugin(stat, cmdline, environ, plugin_names, plugin_folders)
            if plugin is None:
                continue

            fields = stat.rsplit(") ", 1)[1].split()
            cpu_time = int(fields[11]) + int(fields[12])
            rss = self._status_value(status, "VmRSS")

            processes.append(
                {
                    "pid": int(proc_path.name),
                    "name": plugin["name"],
                    "cpu_time": cpu_time,
                    "rss": rss,
                }
            )

        return processes

    def _process_plugin(
        self,
        stat: str,
        cmdline: str,
        environ: str,
        plugin_names: dict[str, dict[str, Any]],
        plugin_folders: dict[str, dict[str, Any]],
    ) -> dict[str, Any] | None:
        for entry in environ.split("\x00"):
            if entry.startswith("DECKY_PLUGIN_NAME="):
                return plugin_names.get(entry.split("=", 1)[1])
            if entry.startswith("DECKY_PLUGIN_DIR="):
                folder = Path(entry.split("=", 1)[1]).name
                return plugin_folders.get(folder)

        process_title = stat.split("(", 1)[1].rsplit(")", 1)[0]
        haystack = f"{process_title}\x00{cmdline}".lower()

        for plugin in plugin_names.values():
            if plugin["name"].lower() in haystack or plugin["folder"].lower() in haystack:
                return plugin

        return None

    def _plugin_metrics(
        self,
        processes: list[dict[str, Any]],
        current_cpu: tuple[int, int],
    ) -> list[dict[str, Any]]:
        total_delta = current_cpu[1] - self._previous_cpu[1] if self._previous_cpu else 0
        grouped: dict[str, dict[str, Any]] = {}

        for process in processes:
            row = grouped.setdefault(
                process["name"],
                {
                    "name": process["name"],
                    "cpu": 0.0,
                    "memory": 0,
                    "processes": 0,
                    "peakCpu": 0.0,
                    "peakMemory": 0,
                    "spike": False,
                    "spikeReason": "",
                },
            )
            previous = self._previous_processes.get(process["pid"], process["cpu_time"])
            process_delta = max(process["cpu_time"] - previous, 0)

            if total_delta > 0:
                row["cpu"] += (process_delta / total_delta) * 100

            row["memory"] += round(process["rss"] / 1024)
            row["processes"] += 1

        history_peaks = self._plugin_history_peaks()
        for row in grouped.values():
            row["cpu"] = round(row["cpu"], 1)
            row["peakCpu"] = max(row["cpu"], history_peaks.get(row["name"], {}).get("cpu", 0.0))
            row["peakMemory"] = max(row["memory"], history_peaks.get(row["name"], {}).get("memory", 0))

            cpu_spike = row["cpu"] >= PLUGIN_CPU_SPIKE and row["cpu"] >= row["peakCpu"] * 0.85
            memory_spike = row["memory"] >= row["peakMemory"] + PLUGIN_MEMORY_SPIKE_MB

            if cpu_spike:
                row["spike"] = True
                row["spikeReason"] = "cpu"
            elif memory_spike:
                row["spike"] = True
                row["spikeReason"] = "ram"

        return sorted(grouped.values(), key=lambda item: (-item["cpu"], -item["memory"], item["name"].lower()))

    def _remember(self, metrics: dict[str, Any]) -> None:
        system_spike = metrics["cpu"] >= SYSTEM_CPU_SPIKE
        metrics["spike"] = system_spike or any(plugin["spike"] for plugin in metrics["plugins"])

        if system_spike:
            metrics["spikeReason"] = "system cpu"
        else:
            metrics["spikeReason"] = next(
                (plugin["spikeReason"] for plugin in metrics["plugins"] if plugin["spike"]),
                "",
            )

        self._history.append(
            {
                "timestamp": metrics["timestamp"],
                "cpu": metrics["cpu"],
                "memory": metrics["memory"]["percent"],
                "plugins": [
                    {
                        "name": plugin["name"],
                        "cpu": plugin["cpu"],
                        "memory": plugin["memory"],
                    }
                    for plugin in metrics["plugins"]
                ],
            }
        )
        self._history = self._history[-HISTORY_LIMIT:]
        metrics["history"] = self._history

    def _plugin_history_peaks(self) -> dict[str, dict[str, float]]:
        peaks: dict[str, dict[str, float]] = {}
        for point in self._history:
            for plugin in point["plugins"]:
                row = peaks.setdefault(plugin["name"], {"cpu": 0.0, "memory": 0.0})
                row["cpu"] = max(row["cpu"], plugin["cpu"])
                row["memory"] = max(row["memory"], plugin["memory"])
        return peaks

    def _status_value(self, status: str, key: str) -> int:
        for line in status.splitlines():
            if line.startswith(f"{key}:"):
                parts = line.split()
                return int(parts[1]) if len(parts) > 1 else 0
        return 0

    def _cpu_percent(self, previous: tuple[int, int], current: tuple[int, int]) -> float:
        idle_delta = current[0] - previous[0]
        total_delta = current[1] - previous[1]
        if total_delta <= 0:
            return 0.0

        return round(max(0.0, min(100.0, (1 - idle_delta / total_delta) * 100)), 1)

    def _read_memory(self) -> dict[str, Any]:
        values: dict[str, int] = {}

        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as meminfo:
                for line in meminfo:
                    key, value = line.split(":", 1)
                    values[key] = int(value.strip().split()[0])
        except OSError:
            return {"used": 0, "total": 0, "percent": 0}

        total = values.get("MemTotal", 0)
        available = values.get("MemAvailable", 0)
        used = max(total - available, 0)
        percent = round((used / total) * 100, 1) if total else 0

        return {
            "used": round(used / 1024),
            "total": round(total / 1024),
            "percent": percent,
        }

    def _disabled_plugins(self) -> set[str]:
        settings_path = Path(decky.DECKY_HOME) / "settings" / "loader.json"
        if not settings_path.exists():
            return set()

        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return set()

        disabled = settings.get("disabled_plugins", [])
        if not isinstance(disabled, list):
            return set()

        return {str(item) for item in disabled}

    def _package_version(self, path: Path) -> str:
        try:
            package = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""

        return str(package.get("version", ""))

    def _schedule_loader_restart(self) -> bool:
        command = (
            "sleep 1; "
            "systemctl restart plugin_loader.service "
            "|| systemctl --user restart plugin_loader.service"
        )

        try:
            subprocess.Popen(
                ["bash", "-lc", command],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError:
            return False

        return True
