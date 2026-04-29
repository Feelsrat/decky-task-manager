import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import decky

# Try to import SSL - may fail on systems with missing OpenSSL
try:
    import ssl
    SSL_AVAILABLE = True
except (ImportError, OSError) as e:
    SSL_AVAILABLE = False
    print(f"Warning: SSL not available ({e}). Will use curl for HTTPS.")


ERROR_PATTERN = re.compile(
    r"\b(error|exception|traceback|critical|fatal|failed|failure)\b",
    re.IGNORECASE,
)
MAX_LOG_BYTES = 512 * 1024
HISTORY_LIMIT = 60
MAX_ERROR_GROUPS = 50
SYSTEM_CPU_SPIKE = 85.0
PLUGIN_CPU_SPIKE = 20.0
PLUGIN_MEMORY_SPIKE_MB = 250
GITHUB_RELEASES_URL = "https://api.github.com/repos/Feelsrat/decky-task-manager/releases"
AUTO_CHECK_INTERVAL = 86400  # 24 hours in seconds


class Plugin:
    def __init__(self):
        self._previous_cpu: tuple[int, int] | None = None
        self._previous_processes: dict[int, int] = {}
        self._history: list[dict[str, Any]] = []
        self._last_update_error = ""
        self._cached_update_status: dict[str, Any] | None = None
        self._last_check_time = 0.0

    async def _main(self):
        decky.logger.info("Decky Task Manager loaded")
        # Auto-check for updates on startup (once per 24 hours)
        asyncio.create_task(self._auto_check_update())

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
        """
        Get system and plugin metrics with peak detection.
        Samples multiple times over ~200ms to catch short spikes.
        """
        first = self._read_cpu_times()
        if self._previous_cpu is None:
            await asyncio.sleep(0.15)
            first = self._read_cpu_times()

        # Take multiple samples to catch spikes (4 samples over 200ms)
        peak_samples: list[dict[str, Any]] = []
        for _ in range(4):
            processes = self._read_plugin_processes(self._list_plugins())
            sample_cpu = self._read_cpu_times()
            plugin_metrics = self._plugin_metrics(processes, sample_cpu)
            peak_samples.append({
                "plugins": plugin_metrics,
                "cpu": self._cpu_percent(first, sample_cpu),
                "memory": self._read_memory(),
            })
            await asyncio.sleep(0.05)  # 50ms between samples
        
        # Merge peaks: for each plugin, take the highest CPU/RAM seen
        merged_plugins: dict[str, dict[str, Any]] = {}
        for sample in peak_samples:
            for plugin in sample["plugins"]:
                name = plugin["name"]
                if name not in merged_plugins:
                    merged_plugins[name] = plugin.copy()
                else:
                    # Take peak values
                    if plugin["cpu"] > merged_plugins[name]["cpu"]:
                        merged_plugins[name]["cpu"] = plugin["cpu"]
                        merged_plugins[name]["peakCpu"] = plugin["cpu"]
                    if plugin["memory"] > merged_plugins[name]["memory"]:
                        merged_plugins[name]["memory"] = plugin["memory"]
                        merged_plugins[name]["peakMemory"] = plugin["memory"]
                    # Update spike status if any sample showed spike
                    if plugin["spike"]:
                        merged_plugins[name]["spike"] = True
                        merged_plugins[name]["spikeReason"] = plugin["spikeReason"]
        
        # Use last sample for system metrics, merged for plugins
        now = time.time()
        metrics = {
            "timestamp": now,
            "cpu": peak_samples[-1]["cpu"],  # Last sample for system
            "memory": peak_samples[-1]["memory"],
            "plugins": list(merged_plugins.values()),
        }

        final_cpu = self._read_cpu_times()
        self._previous_cpu = final_cpu
        self._previous_processes = {
            process["pid"]: process["cpu_time"] 
            for process in self._read_plugin_processes(self._list_plugins())
        }
        self._remember(metrics)
        return metrics

    async def reset_metrics(self) -> dict[str, Any]:
        self._previous_cpu = None
        self._previous_processes = {}
        self._history = []

        return {
            "ok": True,
            "message": "Reset metric history.",
        }

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

    async def enable_plugin(self, name: str) -> dict[str, Any]:
        plugins = self._list_plugins()
        valid_names = {plugin["name"] for plugin in plugins}

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

        if name in disabled_plugins:
            disabled_plugins.remove(name)

        settings["disabled_plugins"] = disabled_plugins
        settings_path.write_text(json.dumps(settings, indent=4), encoding="utf-8")

        restarted = self._schedule_loader_restart()
        return {
            "ok": True,
            "message": f"{name} is enabled.",
            "restarted": restarted,
        }

    async def check_update(self) -> dict[str, Any]:
        # Return cached result if checked within last 24 hours
        if self._cached_update_status and (time.time() - self._last_check_time) < AUTO_CHECK_INTERVAL:
            decky.logger.info("Returning cached update status (checked recently)")
            return self._cached_update_status

        current = self._current_version()
        release = self._latest_release()
        if release is None:
            detail = f" {self._last_update_error}" if self._last_update_error else ""
            result = {
                "ok": False,
                "current": current,
                "hasUpdate": False,
                "canInstall": False,
                "message": f"Could not read GitHub releases.{detail}",
            }
        else:
            latest = str(release.get("tag_name", "")).removeprefix("v")
            asset = self._release_asset(release)
            has_update = bool(latest and latest != current and asset)
            can_install = bool(asset)

            result = {
                "ok": True,
                "current": current,
                "latest": latest,
                "hasUpdate": has_update,
                "canInstall": can_install,
                "assetName": asset.get("name") if asset else "",
                "releaseUrl": release.get("html_url", ""),
                "message": "Update available." if has_update else "Latest release is already installed.",
            }

        # Cache the result
        self._cached_update_status = result
        self._last_check_time = time.time()
        self._update_last_check_time()
        
        return result

    async def install_update(self) -> dict[str, Any]:
        status = await self.check_update()
        if not status.get("ok"):
            return status

        if not status.get("canInstall"):
            return {
                **status,
                "ok": False,
                "message": "No release zip was found.",
            }

        release = self._latest_release()
        asset = self._release_asset(release or {})
        if asset is None:
            return {
                **status,
                "ok": False,
                "message": "No release zip was found.",
            }

        try:
            self._install_release_zip(str(asset["browser_download_url"]))
        except ValueError as error:
            decky.logger.exception("Update failed - invalid ZIP structure: %s", error)
            return {
                **status,
                "ok": False,
                "message": f"Update failed: {error}. Check ~/homebrew/logs/decky-task-manager/ for details.",
            }
        except urllib.error.URLError as error:
            decky.logger.exception("Update failed - download error: %s", error)
            return {
                **status,
                "ok": False,
                "message": "Update failed: Could not download release. Check internet connection.",
            }
        except zipfile.BadZipFile as error:
            decky.logger.exception("Update failed - corrupt ZIP: %s", error)
            return {
                **status,
                "ok": False,
                "message": "Update failed: Downloaded ZIP is corrupted. Try again.",
            }
        except OSError as error:
            decky.logger.exception("Update failed - file system error: %s", error)
            return {
                **status,
                "ok": False,
                "message": f"Update failed: {error}. Check ~/homebrew/logs/decky-task-manager/ for details.",
            }

        # Kill any old plugin processes before restarting
        self._kill_old_processes()
        
        restarted = self._schedule_loader_restart()
        return {
            **status,
            "ok": True,
            "restarted": restarted,
            "message": (
                "Update installed! Decky will restart now." if restarted
                else "Update installed! Please restart Steam to apply changes."
            ),
        }

    async def _auto_check_update(self) -> None:
        """
        Automatically check for updates on plugin load.
        Respects 24-hour cache from check_update().
        """
        try:
            decky.logger.info("Running automatic update check on startup")
            status = await self.check_update()
            
            if status.get("hasUpdate"):
                decky.logger.info(
                    "Update available: %s → %s",
                    status.get("current", "unknown"),
                    status.get("latest", "unknown"),
                )
            else:
                decky.logger.info("Plugin is up to date")
        except Exception as error:
            decky.logger.warning("Auto-update check failed: %s", error)

    def _should_auto_check(self) -> bool:
        """Check if 24 hours have passed since last update check."""
        check_file = Path(decky.DECKY_PLUGIN_DIR) / ".last_update_check"
        
        if not check_file.exists():
            return True
        
        try:
            last_check = float(check_file.read_text(encoding="utf-8").strip())
            elapsed = time.time() - last_check
            return elapsed >= AUTO_CHECK_INTERVAL
        except (OSError, ValueError):
            return True

    def _update_last_check_time(self) -> None:
        """Update the timestamp of the last update check."""
        check_file = Path(decky.DECKY_PLUGIN_DIR) / ".last_update_check"
        try:
            check_file.write_text(str(time.time()), encoding="utf-8")
        except OSError as error:
            decky.logger.warning("Failed to update last check time: %s", error)

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
                    "groups": sorted(
                        grouped.values(),
                        key=lambda item: (-item["count"], item["message"].lower()),
                    )[:MAX_ERROR_GROUPS],
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

    def _current_version(self) -> str:
        package_path = Path(decky.DECKY_PLUGIN_DIR) / "package.json"
        return self._package_version(package_path)

    def _latest_release(self) -> dict[str, Any] | None:
        self._last_update_error = ""
        releases = self._fetch_json(GITHUB_RELEASES_URL)
        if releases is None:
            return None

        if not isinstance(releases, list):
            self._last_update_error = "GitHub returned an unexpected response."
            return None

        for release in releases:
            if release.get("draft"):
                continue
            if self._release_asset(release):
                return release

        return None

    def _fetch_json(self, url: str) -> Any | None:
        # Try Python urllib with SSL context first (if SSL is available)
        if SSL_AVAILABLE:
            try:
                ssl_context = ssl.create_default_context()
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
                
                request = urllib.request.Request(
                    url,
                    headers={
                        "Accept": "application/vnd.github+json",
                        "User-Agent": "decky-task-manager",
                    },
                )
                
                with urllib.request.urlopen(request, timeout=10, context=ssl_context) as response:
                    return json.loads(response.read().decode("utf-8"))
            except (OSError, json.JSONDecodeError, urllib.error.URLError) as error:
                self._last_update_error = f"Python fetch failed: {error}"
        else:
            decky.logger.info("SSL not available, using curl for HTTPS")

        # Fallback to curl
        try:
            result = subprocess.run(
                ["curl", "-fsSL", "-k", "-H", "Accept: application/vnd.github+json", "-A", "decky-task-manager", url],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            self._last_update_error += f"; curl failed: {error}"
            return None

        if result.returncode != 0:
            self._last_update_error += f"; curl exited {result.returncode}: {result.stderr.strip()[-120:]}"
            return None

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            self._last_update_error += f"; curl JSON parse failed: {error}"
            return None

    def _release_asset(self, release: dict[str, Any]) -> dict[str, Any] | None:
        assets = release.get("assets", [])
        if not isinstance(assets, list):
            return None

        for asset in assets:
            name = str(asset.get("name", ""))
            if name.endswith(".zip") and "decky-task-manager" in name:
                return asset

        return None

    def _install_release_zip(self, url: str) -> None:
        decky.logger.info(f"Starting update installation from: {url}")
        plugin_dir = Path(decky.DECKY_PLUGIN_DIR)
        decky.logger.info(f"Plugin directory: {plugin_dir}")
        
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "decky-task-manager"},
        )

        with tempfile.TemporaryDirectory(prefix="decky-task-manager-update-") as temp_root:
            temp_path = Path(temp_root)
            archive_path = temp_path / "release.zip"
            decky.logger.info(f"Downloading to: {archive_path}")

            self._download_file(request, archive_path)
            decky.logger.info(f"Download complete. File size: {archive_path.stat().st_size} bytes")

            extract_dir = temp_path / "extract"
            decky.logger.info(f"Extracting to: {extract_dir}")
            
            with zipfile.ZipFile(archive_path) as archive:
                decky.logger.info(f"ZIP contains {len(archive.namelist())} files")
                for name in archive.namelist()[:5]:  # Log first 5 files
                    decky.logger.info(f"  - {name}")
                self._safe_extract(archive, extract_dir)
            
            decky.logger.info("Extraction complete, looking for plugin...")
            extracted_plugin = self._find_extracted_plugin(extract_dir)
            if extracted_plugin is None:
                decky.logger.error(f"No plugin.json found in extracted files. Contents: {list(extract_dir.iterdir())}")
                raise ValueError("release zip did not contain a Decky plugin")
            
            decky.logger.info(f"Found plugin at: {extracted_plugin}")

            backup_dir = plugin_dir.with_name(f"{plugin_dir.name}.previous")
            if backup_dir.exists():
                decky.logger.info(f"Removing old backup: {backup_dir}")
                shutil.rmtree(backup_dir)

            if plugin_dir.exists():
                decky.logger.info(f"Backing up current plugin to: {backup_dir}")
                shutil.copytree(plugin_dir, backup_dir, ignore=shutil.ignore_patterns("*.log"))
            
            decky.logger.info("Installing updated files...")
            for item in extracted_plugin.iterdir():
                target = plugin_dir / item.name
                if target.exists():
                    if target.is_dir():
                        shutil.rmtree(target)
                    else:
                        target.unlink()

                if item.is_dir():
                    shutil.copytree(item, target)
                else:
                    shutil.copy2(item, target)
                decky.logger.info(f"  Installed: {item.name}")
            
            decky.logger.info("Update installation complete!")

    def _find_extracted_plugin(self, root: Path) -> Path | None:
        for candidate in [root, *root.iterdir()]:
            if not candidate.is_dir():
                continue
            if (candidate / "plugin.json").exists() and (candidate / "package.json").exists():
                return candidate
        return None

    def _safe_extract(self, archive: zipfile.ZipFile, target: Path) -> None:
        target.mkdir(parents=True, exist_ok=True)
        resolved_target = target.resolve()

        for member in archive.infolist():
            destination = (target / member.filename).resolve()
            if not destination.is_relative_to(resolved_target):
                raise ValueError(f"Attempted path traversal in zip: {member.filename}")

        archive.extractall(target)

    def _download_file(self, request: urllib.request.Request, target: Path) -> None:
        decky.logger.info(f"Attempting download from: {request.full_url}")
        
        # Try Python urllib with SSL context first (if SSL is available)
        if SSL_AVAILABLE:
            try:
                ssl_context = ssl.create_default_context()
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
                
                decky.logger.info("Trying Python urllib...")
                with urllib.request.urlopen(request, timeout=45, context=ssl_context) as response:
                    data = response.read()
                    target.write_bytes(data)
                    decky.logger.info(f"Download successful via urllib: {len(data)} bytes")
                    return
            except (OSError, urllib.error.URLError) as error:
                decky.logger.warning(f"Python download failed, trying curl: {error}")
        else:
            decky.logger.info("SSL not available, using curl for download")

        # Fallback to curl
        decky.logger.info("Trying curl fallback...")
        result = subprocess.run(
            ["curl", "-fL", "-k", "-A", "decky-task-manager", "-o", str(target), request.full_url],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            decky.logger.error(f"curl failed with exit code {result.returncode}: {result.stderr}")
            raise urllib.error.URLError(result.stderr.strip() or f"curl exited {result.returncode}")
        
        decky.logger.info(f"Download successful via curl")

    def _schedule_loader_restart(self) -> bool:
        decky.logger.info("Attempting to restart Decky Loader...")
        
        # Try multiple restart commands, fire-and-forget with proper detachment
        commands = [
            "sleep 2 && systemctl restart plugin_loader",
            "sleep 2 && systemctl --user restart plugin_loader",
            "sleep 2 && systemctl restart plugin_loader.service",
            "sleep 2 && systemctl --user restart plugin_loader.service",
        ]
        
        for cmd in commands:
            try:
                decky.logger.info(f"Trying: {cmd}")
                # Use Popen with full detachment - don't wait for result
                process = subprocess.Popen(
                    ["bash", "-c", cmd],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,  # Fully detach from parent
                    preexec_fn=os.setpgrp if hasattr(os, 'setpgrp') else None,  # New process group
                )
                decky.logger.info(f"✓ Restart scheduled (detached PID: {process.pid})")
                # Return immediately - don't wait for the restart
                return True
            except Exception as error:
                decky.logger.warning(f"Exception with '{cmd}': {error}")
                continue
        
        decky.logger.error("All restart methods failed - manual restart required")
        return False

    def _kill_old_processes(self) -> None:
        """
        Kill any old decky-task-manager Python processes before restarting.
        This prevents zombie processes from staying alive after updates.
        """
        try:
            current_pid = os.getpid()
            plugin_dir = str(Path(decky.DECKY_PLUGIN_DIR).resolve())
            
            decky.logger.info(f"Searching for old processes (current PID: {current_pid})")
            
            # Find all Python processes running from this plugin directory
            result = subprocess.run(
                ["pgrep", "-f", plugin_dir],
                capture_output=True,
                text=True,
                timeout=5,
            )
            
            if result.returncode == 0:
                pids = [int(pid) for pid in result.stdout.strip().split("\n") if pid]
                decky.logger.info(f"Found {len(pids)} process(es) for this plugin: {pids}")
                
                for pid in pids:
                    if pid == current_pid:
                        decky.logger.info(f"Skipping current process (PID: {pid})")
                        continue
                    
                    try:
                        decky.logger.info(f"Killing old process PID: {pid}")
                        subprocess.run(["kill", "-9", str(pid)], timeout=2, check=False)
                        decky.logger.info(f"✓ Killed PID: {pid}")
                    except Exception as error:
                        decky.logger.warning(f"Failed to kill PID {pid}: {error}")
            else:
                decky.logger.info("No additional plugin processes found")
                
        except Exception as error:
            decky.logger.warning(f"Failed to kill old processes: {error}")
