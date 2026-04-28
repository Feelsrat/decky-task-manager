import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

import decky


ERROR_PATTERN = re.compile(
    r"\b(error|exception|traceback|critical|fatal|failed|failure)\b",
    re.IGNORECASE,
)
MAX_LOG_BYTES = 512 * 1024


class Plugin:
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
            "plugins": plugins,
            "logs": logs,
            "metrics": metrics,
        }

    async def get_metrics(self) -> dict[str, Any]:
        first = self._read_cpu_times()
        await asyncio.sleep(0.15)
        second = self._read_cpu_times()

        return {
            "cpu": self._cpu_percent(first, second),
            "memory": self._read_memory(),
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

            for log_path in paths:
                lines = self._tail_lines(log_path)
                file_errors = [line.strip() for line in lines if ERROR_PATTERN.search(line)]
                errors += len(file_errors)
                totals["files"] += 1

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

    def _cpu_percent(self, first: tuple[int, int], second: tuple[int, int]) -> float:
        idle_delta = second[0] - first[0]
        total_delta = second[1] - first[1]
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
