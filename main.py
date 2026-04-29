import asyncio
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from collections import deque
from heapq import nlargest
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
AUTO_UPDATE_CHECK_ON_STARTUP = False
MONITORING_POLL_SECONDS = 1.0
LOG_ALERT_POLL_SECONDS = 5.0
LOG_SPAM_BYTES_PER_SECOND = 4096
LOG_SPAM_LINES_PER_SECOND = 10
LOG_SPAM_ERRORS_PER_SECOND = 1.0

SEVERITY_RANK = {
    "info": 0,
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}

KNOWN_ERROR_RULES: tuple[dict[str, Any], ...] = (
    {
        "id": "traceback",
        "severity": "critical",
        "title": "Python crash traceback",
        "pattern": re.compile(r"\btraceback \(most recent call last\)|\bunhandled exception\b", re.IGNORECASE),
        "advice": "The plugin backend threw an unhandled exception.",
    },
    {
        "id": "oom",
        "severity": "critical",
        "title": "Out of memory",
        "pattern": re.compile(r"\bout of memory\b|\boom-kill|cannot allocate memory", re.IGNORECASE),
        "advice": "The plugin or system is running out of memory.",
    },
    {
        "id": "permission",
        "severity": "high",
        "title": "Permission failure",
        "pattern": re.compile(r"\bpermission denied\b|\boperation not permitted\b|\beacces\b", re.IGNORECASE),
        "advice": "The plugin tried to access something it is not allowed to use.",
    },
    {
        "id": "missing_dependency",
        "severity": "high",
        "title": "Missing dependency",
        "pattern": re.compile(r"no module named|module not found|cannot import name|importerror", re.IGNORECASE),
        "advice": "A required Python or JavaScript dependency is missing.",
    },
    {
        "id": "syntax",
        "severity": "high",
        "title": "Syntax or startup failure",
        "pattern": re.compile(r"\bsyntaxerror\b|\bindentationerror\b|failed to load plugin", re.IGNORECASE),
        "advice": "The plugin may not start until its files are fixed or reinstalled.",
    },
    {
        "id": "disk",
        "severity": "high",
        "title": "Disk write failure",
        "pattern": re.compile(r"no space left on device|read-only file system|disk quota", re.IGNORECASE),
        "advice": "The plugin cannot write to disk.",
    },
    {
        "id": "config",
        "severity": "medium",
        "title": "Config parse failure",
        "pattern": re.compile(r"jsondecodeerror|toml|yaml|parse error|invalid config", re.IGNORECASE),
        "advice": "A settings or cache file may be corrupt.",
    },
    {
        "id": "network",
        "severity": "medium",
        "title": "Network/API failure",
        "pattern": re.compile(r"connection refused|connection timed out|temporary failure|ssl|certificate|http (4\d\d|5\d\d)|rate limit", re.IGNORECASE),
        "advice": "The plugin is failing an external request.",
    },
    {
        "id": "steam_api",
        "severity": "medium",
        "title": "Steam client API failure",
        "pattern": re.compile(r"steam(client|ui|webhelper)|cef|websocket|jsbridge", re.IGNORECASE),
        "advice": "The plugin is failing while talking to Steam UI or CEF.",
    },
)


class Plugin:
    def __init__(self):
        self._previous_cpu: tuple[int, int] | None = None
        self._previous_processes: dict[int, int] = {}
        self._plugin_resource_peaks: dict[str, dict[str, float]] = {}
        # Deque for O(1) append and automatic size limiting (circular buffer pattern)
        self._history: deque[dict[str, Any]] = deque(maxlen=HISTORY_LIMIT)
        self._last_update_error = ""
        self._cached_update_status: dict[str, Any] | None = None
        self._last_check_time = 0.0
        self._auto_update_task: asyncio.Task[None] | None = None
        self._install_lock = asyncio.Lock()
        self._monitoring_enabled = False
        self._monitoring_task: asyncio.Task[None] | None = None
        self._latest_metrics: dict[str, Any] | None = None
        self._latest_logs: dict[str, Any] | None = None
        self._last_log_scan = 0.0
        self._log_activity: dict[str, dict[str, Any]] = {}
        self._metrics_lock = asyncio.Lock()

    async def _main(self):
        decky.logger.info("Decky Task Manager loaded")
        self._cleanup_previous_update_artifacts()
        if AUTO_UPDATE_CHECK_ON_STARTUP and self._should_auto_check():
            self._auto_update_task = asyncio.create_task(self._auto_check_update())

    async def _unload(self):
        self._monitoring_enabled = False
        await self._stop_monitoring_task()
        await self._stop_auto_update_task()
        decky.logger.info("Decky Task Manager unloaded")

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass

    async def get_snapshot(self) -> dict[str, Any]:
        plugins = self._list_plugins()
        logs = self._scan_logs(plugins)
        self._latest_logs = logs
        metrics = await self.get_metrics()

        return {
            "plugins": self._merge_plugin_data(plugins, logs, metrics),
            "logs": logs,
            "metrics": metrics,
        }

    async def get_metrics(self) -> dict[str, Any]:
        async with self._metrics_lock:
            metrics = await self._collect_metrics()
            self._latest_metrics = metrics
            return metrics

    async def get_monitoring_state(self) -> dict[str, Any]:
        if self._monitoring_enabled:
            self._ensure_monitoring_task()

        return {
            "enabled": self._monitoring_enabled,
            "metrics": self._latest_metrics,
            "logs": self._latest_logs,
            "pollIntervalMs": int(MONITORING_POLL_SECONDS * 1000),
        }

    async def set_monitoring(self, enabled: bool) -> dict[str, Any]:
        self._monitoring_enabled = bool(enabled)

        if self._monitoring_enabled:
            await self.get_metrics()
            self._ensure_monitoring_task()
        else:
            await self._stop_monitoring_task()

        return await self.get_monitoring_state()

    async def _collect_metrics(self) -> dict[str, Any]:
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
                    if plugin["memory"] > merged_plugins[name]["memory"]:
                        merged_plugins[name]["memory"] = plugin["memory"]
                    merged_plugins[name]["peakCpu"] = max(merged_plugins[name]["peakCpu"], plugin["peakCpu"])
                    merged_plugins[name]["peakMemory"] = max(merged_plugins[name]["peakMemory"], plugin["peakMemory"])
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

    def _ensure_monitoring_task(self) -> None:
        if self._monitoring_task is not None and not self._monitoring_task.done():
            return

        self._monitoring_task = asyncio.create_task(self._monitoring_loop())

    async def _stop_monitoring_task(self) -> None:
        task = self._monitoring_task
        self._monitoring_task = None

        if task is None or task.done():
            return

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _monitoring_loop(self) -> None:
        try:
            while self._monitoring_enabled:
                await asyncio.sleep(MONITORING_POLL_SECONDS)
                if self._monitoring_enabled:
                    try:
                        await self.get_metrics()
                    except Exception as error:
                        decky.logger.warning("Live monitoring sample failed: %s", error)

                now = time.time()
                if self._monitoring_enabled and now - self._last_log_scan >= LOG_ALERT_POLL_SECONDS:
                    try:
                        self._latest_logs = self._scan_logs(self._list_plugins())
                        self._last_log_scan = now
                    except Exception as error:
                        decky.logger.warning("Live monitoring log scan failed: %s", error)
        except asyncio.CancelledError:
            raise

    async def _stop_auto_update_task(self) -> None:
        task = self._auto_update_task
        self._auto_update_task = None

        if task is None or task.done():
            return

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def reset_metrics(self) -> dict[str, Any]:
        async with self._metrics_lock:
            self._previous_cpu = None
            self._previous_processes = {}
            self._plugin_resource_peaks.clear()
            self._latest_metrics = None
            # Clear deque instead of reassigning (maintains maxlen property)
            self._history.clear()

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

        restart = self._schedule_loader_restart("plugin disabled")
        return {
            "ok": True,
            "message": f"{name} is disabled.",
            "restarted": restart["scheduled"],
            "restart": restart,
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

        restart = self._schedule_loader_restart("plugin enabled")
        return {
            "ok": True,
            "message": f"{name} is enabled.",
            "restarted": restart["scheduled"],
            "restart": restart,
        }

    async def kill_plugin_processes(self, name: str) -> dict[str, Any]:
        plugins = self._list_plugins()
        valid_names = {plugin["name"] for plugin in plugins}

        if name == "Decky Task Manager":
            return {"ok": False, "message": "Decky Task Manager cannot kill itself."}

        if name not in valid_names:
            return {"ok": False, "message": f"{name} was not found."}

        current_pid = os.getpid()
        processes = [
            process
            for process in self._read_plugin_processes(plugins)
            if process["name"] == name and process["pid"] != current_pid
        ]

        if not processes:
            return {
                "ok": True,
                "message": f"No running processes found for {name}.",
                "terminated": [],
                "killed": [],
                "failed": [],
            }

        terminated: list[int] = []
        killed: list[int] = []
        failed: list[dict[str, Any]] = []

        for process in processes:
            pid = int(process["pid"])
            try:
                os.kill(pid, signal.SIGTERM)
                terminated.append(pid)
            except ProcessLookupError:
                continue
            except OSError as error:
                failed.append({"pid": pid, "error": str(error)})

        await asyncio.sleep(0.5)

        sigkill = getattr(signal, "SIGKILL", signal.SIGTERM)
        for pid in terminated:
            if not self._pid_is_running(pid):
                continue

            try:
                os.kill(pid, sigkill)
                killed.append(pid)
            except ProcessLookupError:
                continue
            except OSError as error:
                failed.append({"pid": pid, "error": str(error)})

        ok = len(failed) == 0
        affected = len(set([*terminated, *killed]))
        return {
            "ok": ok,
            "terminated": terminated,
            "killed": killed,
            "failed": failed,
            "message": (
                f"Sent kill signal to {affected} {name} process{'es' if affected != 1 else ''}."
                if ok
                else f"Could not kill every {name} process."
            ),
        }

    async def get_update_status(self) -> dict[str, Any]:
        current = self._current_version()
        if self._cached_update_status and (time.time() - self._last_check_time) < AUTO_CHECK_INTERVAL:
            return {
                **self._cached_update_status,
                "current": current,
                "elevated": self._has_elevated_permissions(),
            }

        return {
            "ok": True,
            "current": current,
            "elevated": self._has_elevated_permissions(),
            "hasUpdate": False,
            "canInstall": False,
            "message": "Ready to check for updates.",
        }

    async def check_update(self, force: bool = False) -> dict[str, Any]:
        # Return cached result if checked within last 24 hours
        if not force and self._cached_update_status and (time.time() - self._last_check_time) < AUTO_CHECK_INTERVAL:
            decky.logger.info("Returning cached update status (checked recently)")
            return self._cached_update_status

        current = self._current_version()
        elevated = self._has_elevated_permissions()
        release = self._latest_release()
        if release is None:
            detail = f" {self._last_update_error}" if self._last_update_error else ""
            result = {
                "ok": False,
                "current": current,
                "elevated": elevated,
                "hasUpdate": False,
                "canInstall": False,
                "message": f"Could not read GitHub releases.{detail}",
            }
        else:
            latest = str(release.get("tag_name", "")).removeprefix("v")
            asset = self._release_asset(release)
            # Use semantic version comparison instead of string equality (DSA: Tuple Comparison)
            has_update = bool(latest and self._is_newer_version(current, latest) and asset)
            can_install = bool(asset)

            result = {
                "ok": True,
                "current": current,
                "latest": latest,
                "elevated": elevated,
                "hasUpdate": has_update,
                "canInstall": can_install and elevated,
                "assetName": asset.get("name") if asset else "",
                "releaseUrl": release.get("html_url", ""),
                "message": (
                    "Update available." if has_update and elevated
                    else "Root permissions are required to install updates." if has_update
                    else "Latest release is already installed."
                ),
            }

        # Cache the result
        self._cached_update_status = result
        self._last_check_time = time.time()
        self._update_last_check_time()
        
        return result

    async def install_update(self) -> dict[str, Any]:
        async with self._install_lock:
            status = await self.check_update(force=True)
            if not status.get("ok"):
                return status

            if not self._has_elevated_permissions():
                return {
                    **status,
                    "ok": False,
                    "canInstall": False,
                    "message": "Update install requires elevated Decky permissions.",
                }

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
                await self._stop_monitoring_task()
                install_info = self._install_release_zip(str(asset["browser_download_url"]))
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

            current = self._current_version()
            latest = str(status.get("latest") or current)
            restart = self._schedule_loader_restart("plugin updated")
            result = {
                **status,
                **install_info,
                "ok": True,
                "current": current,
                "latest": latest,
                "hasUpdate": self._is_newer_version(current, latest),
                "canInstall": bool(status.get("canInstall")),
                "restarted": restart["scheduled"],
                "restart": restart,
                "requiresRestart": True,
                "message": (
                    f"Installed {current}. Decky restart scheduled."
                    if restart["scheduled"]
                    else f"Installed {current}. Restart Steam or Decky Loader to finish."
                ),
            }
            self._cached_update_status = result
            self._last_check_time = time.time()
            return result

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
        # Use hash tables for O(1) lookups instead of O(n) list searches (DSA: Hash Table)
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
        totals = {
            "errors": 0,
            "files": 0,
            "critical": 0,
            "high": 0,
            "medium": 0,
            "low": 0,
            "alerts": 0,
            "serious": 0,
            "noisyPlugins": 0,
        }

        for plugin in plugins:
            paths = self._log_paths_for_plugin(log_root, plugin)
            errors = 0
            examples: list[str] = []
            grouped: dict[str, dict[str, Any]] = {}
            issue_map: dict[str, dict[str, Any]] = {}
            plugin_rate = {
                "bytesPerSecond": 0.0,
                "linesPerSecond": 0.0,
                "errorsPerSecond": 0.0,
                "active": False,
            }

            for log_path in paths:
                rate = self._log_rate(log_path)
                plugin_rate["bytesPerSecond"] += rate["bytesPerSecond"]
                plugin_rate["linesPerSecond"] += rate["linesPerSecond"]
                plugin_rate["errorsPerSecond"] += rate["errorsPerSecond"]

                lines = self._tail_lines(log_path)
                file_errors = [line.strip() for line in lines if ERROR_PATTERN.search(line)]
                errors += len(file_errors)
                totals["files"] += 1

                for line in file_errors:
                    for issue in self._known_issues_for_line(line, plugin):
                        current_issue = issue_map.setdefault(
                            issue["id"],
                            {
                                "id": issue["id"],
                                "severity": issue["severity"],
                                "title": issue["title"],
                                "advice": issue["advice"],
                                "count": 0,
                                "files": set(),
                                "examples": [],
                            },
                        )
                        current_issue["count"] += 1
                        current_issue["files"].add(str(log_path.relative_to(log_root)))
                        if len(current_issue["examples"]) < 2:
                            current_issue["examples"].append(line[-220:])

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

            plugin_rate = {
                **plugin_rate,
                "bytesPerSecond": round(plugin_rate["bytesPerSecond"], 1),
                "linesPerSecond": round(plugin_rate["linesPerSecond"], 1),
                "errorsPerSecond": round(plugin_rate["errorsPerSecond"], 2),
            }
            plugin_rate["active"] = (
                plugin_rate["bytesPerSecond"] >= LOG_SPAM_BYTES_PER_SECOND
                or plugin_rate["linesPerSecond"] >= LOG_SPAM_LINES_PER_SECOND
                or plugin_rate["errorsPerSecond"] >= LOG_SPAM_ERRORS_PER_SECOND
            )

            alerts = self._log_rate_alerts(plugin_rate)
            known_issues = [
                {
                    **issue,
                    "files": sorted(issue["files"]),
                }
                for issue in issue_map.values()
            ]
            known_issues.sort(
                key=lambda issue: (
                    -SEVERITY_RANK.get(str(issue["severity"]), 0),
                    -int(issue["count"]),
                    str(issue["title"]).lower(),
                )
            )

            severity = self._plugin_log_severity(errors, known_issues, alerts)
            if severity in totals:
                totals[severity] += 1
            if SEVERITY_RANK.get(severity, 0) >= SEVERITY_RANK["high"]:
                totals["serious"] += 1
            if alerts:
                totals["alerts"] += len(alerts)
            if plugin_rate["active"]:
                totals["noisyPlugins"] += 1
            
            # Use heap to get top N error groups efficiently (DSA: Min-Heap)
            # nlargest is O(n log k) instead of O(n log n) for full sort
            top_groups = nlargest(
                MAX_ERROR_GROUPS,
                grouped.values(),
                key=lambda item: (item["count"], item["message"].lower())
            )
            
            plugin_rows.append(
                {
                    "name": plugin["name"],
                    "folder": plugin["folder"],
                    "errors": errors,
                    "files": len(paths),
                    "examples": examples,
                    "groups": top_groups,
                    "knownIssues": known_issues,
                    "alerts": alerts,
                    "rate": plugin_rate,
                    "severity": severity,
                    "serious": SEVERITY_RANK.get(severity, 0) >= SEVERITY_RANK["high"],
                }
            )

        plugin_rows.sort(key=lambda item: (-item["errors"], item["name"].lower()))
        return {"plugins": plugin_rows, "totals": totals}

    def _known_issues_for_line(self, line: str, plugin: dict[str, Any]) -> list[dict[str, Any]]:
        matches: list[dict[str, Any]] = []
        plugin_name = str(plugin.get("name", "")).lower()
        plugin_folder = str(plugin.get("folder", "")).lower()

        for rule in KNOWN_ERROR_RULES:
            plugin_filters = rule.get("plugins")
            if plugin_filters and not any(
                str(name).lower() in plugin_name or str(name).lower() in plugin_folder
                for name in plugin_filters
            ):
                continue

            pattern = rule["pattern"]
            if pattern.search(line):
                matches.append(
                    {
                        "id": rule["id"],
                        "severity": rule["severity"],
                        "title": rule["title"],
                        "advice": rule["advice"],
                    }
                )

        return matches

    def _log_rate(self, path: Path) -> dict[str, float]:
        now = time.time()
        key = str(path)

        try:
            stat = path.stat()
        except OSError:
            return {"bytesPerSecond": 0.0, "linesPerSecond": 0.0, "errorsPerSecond": 0.0}

        previous = self._log_activity.get(key)
        self._log_activity[key] = {
            "size": stat.st_size,
            "checkedAt": now,
            "mtime": stat.st_mtime,
        }

        if previous is None:
            return {"bytesPerSecond": 0.0, "linesPerSecond": 0.0, "errorsPerSecond": 0.0}

        elapsed = max(now - float(previous.get("checkedAt", now)), 0.001)
        previous_size = int(previous.get("size", stat.st_size))
        if stat.st_size < previous_size:
            return {"bytesPerSecond": 0.0, "linesPerSecond": 0.0, "errorsPerSecond": 0.0}

        delta_bytes = stat.st_size - previous_size
        if delta_bytes <= 0:
            return {"bytesPerSecond": 0.0, "linesPerSecond": 0.0, "errorsPerSecond": 0.0}

        appended = self._read_log_delta(path, previous_size, delta_bytes)
        lines = appended.decode("utf-8", errors="replace").splitlines()
        error_lines = [line for line in lines if ERROR_PATTERN.search(line)]

        return {
            "bytesPerSecond": delta_bytes / elapsed,
            "linesPerSecond": len(lines) / elapsed,
            "errorsPerSecond": len(error_lines) / elapsed,
        }

    def _read_log_delta(self, path: Path, previous_size: int, delta_bytes: int) -> bytes:
        try:
            with path.open("rb") as handle:
                if delta_bytes > MAX_LOG_BYTES:
                    handle.seek(max(path.stat().st_size - MAX_LOG_BYTES, 0))
                    return handle.read(MAX_LOG_BYTES)

                handle.seek(previous_size)
                return handle.read(delta_bytes)
        except OSError:
            return b""

    def _log_rate_alerts(self, rate: dict[str, Any]) -> list[dict[str, Any]]:
        alerts: list[dict[str, Any]] = []

        if rate["errorsPerSecond"] >= LOG_SPAM_ERRORS_PER_SECOND:
            alerts.append(
                {
                    "id": "error_spam",
                    "severity": "high",
                    "title": "Log errors are repeating",
                    "message": f"{rate['errorsPerSecond']:.1f} errors/sec",
                }
            )

        if rate["linesPerSecond"] >= LOG_SPAM_LINES_PER_SECOND:
            alerts.append(
                {
                    "id": "line_spam",
                    "severity": "medium",
                    "title": "Log is being written constantly",
                    "message": f"{rate['linesPerSecond']:.1f} lines/sec",
                }
            )

        if rate["bytesPerSecond"] >= LOG_SPAM_BYTES_PER_SECOND:
            alerts.append(
                {
                    "id": "byte_spam",
                    "severity": "medium",
                    "title": "Log file is growing quickly",
                    "message": f"{round(rate['bytesPerSecond'] / 1024, 1)} KB/sec",
                }
            )

        return alerts

    def _plugin_log_severity(
        self,
        errors: int,
        known_issues: list[dict[str, Any]],
        alerts: list[dict[str, Any]],
    ) -> str:
        severity = "info"
        for issue in [*known_issues, *alerts]:
            issue_severity = str(issue.get("severity", "info"))
            if SEVERITY_RANK.get(issue_severity, 0) > SEVERITY_RANK.get(severity, 0):
                severity = issue_severity

        if severity == "info" and errors >= 50:
            return "medium"
        if severity == "info" and errors > 0:
            return "low"

        return severity

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

    def _pid_is_running(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False

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
            name = row["name"]
            stored_peaks = self._plugin_resource_peaks.setdefault(name, {"cpu": 0.0, "memory": 0.0})
            previous_peak_cpu = max(stored_peaks.get("cpu", 0.0), history_peaks.get(name, {}).get("cpu", 0.0))
            previous_peak_memory = max(stored_peaks.get("memory", 0.0), history_peaks.get(name, {}).get("memory", 0.0))

            row["peakCpu"] = round(max(row["cpu"], previous_peak_cpu), 1)
            row["peakMemory"] = int(max(row["memory"], previous_peak_memory))
            stored_peaks["cpu"] = row["peakCpu"]
            stored_peaks["memory"] = row["peakMemory"]

            cpu_spike = row["cpu"] >= PLUGIN_CPU_SPIKE and (
                previous_peak_cpu <= 0 or row["cpu"] >= previous_peak_cpu * 0.85
            )
            memory_spike = row["memory"] >= PLUGIN_MEMORY_SPIKE_MB and (
                previous_peak_memory <= 0 or row["memory"] >= previous_peak_memory + PLUGIN_MEMORY_SPIKE_MB
            )

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

        # Deque automatically handles maxlen - no manual slicing needed (DSA: Circular Buffer)
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
        # Convert deque to list for JSON serialization
        metrics["history"] = list(self._history)

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

    def _has_elevated_permissions(self) -> bool:
        if not hasattr(os, "geteuid"):
            return True

        return os.geteuid() == 0

    def _parse_version(self, version: str) -> tuple[int, ...]:
        """
        Parse semantic version string to tuple for comparison (DSA: Tuple Comparison).
        Converts "1.2.3" to (1, 2, 3) for proper version ordering.
        Example: (0, 1, 10) > (0, 1, 9) but "0.1.10" < "0.1.9" as strings.
        """
        try:
            # Remove 'v' prefix and split by dots
            clean = version.removeprefix("v").split("-")[0]  # Handle "1.2.3-beta" -> "1.2.3"
            return tuple(int(part) for part in clean.split(".") if part.isdigit())
        except (ValueError, AttributeError):
            return (0,)  # Fallback for invalid versions

    def _is_newer_version(self, current: str, latest: str) -> bool:
        """
        Compare versions using tuple comparison (DSA: Lexicographic Ordering).
        Returns True if latest > current semantically.
        """
        current_tuple = self._parse_version(current)
        latest_tuple = self._parse_version(latest)
        return latest_tuple > current_tuple

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

    def _install_release_zip(self, url: str) -> dict[str, Any]:
        decky.logger.info(f"Starting update installation from: {url}")
        plugin_dir = Path(decky.DECKY_PLUGIN_DIR).resolve()
        plugin_parent = plugin_dir.parent
        staging_dir = plugin_parent / f".{plugin_dir.name}.update-{os.getpid()}-{int(time.time())}"
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
            self._validate_extracted_plugin(extracted_plugin)

            backup_dir = plugin_dir.with_name(f"{plugin_dir.name}.previous")

            if staging_dir.exists():
                decky.logger.info(f"Removing stale staging directory: {staging_dir}")
                shutil.rmtree(staging_dir)

            decky.logger.info(f"Staging updated plugin at: {staging_dir}")
            shutil.copytree(
                extracted_plugin,
                staging_dir,
                symlinks=True,
                ignore=shutil.ignore_patterns("*.log", "__pycache__", ".last_update_check"),
            )
            self._validate_extracted_plugin(staging_dir)

            if backup_dir.exists():
                decky.logger.info(f"Removing old backup: {backup_dir}")
                shutil.rmtree(backup_dir)

            decky.logger.info("Replacing plugin directory")
            moved_existing = False
            try:
                if plugin_dir.exists():
                    plugin_dir.rename(backup_dir)
                    moved_existing = True
                staging_dir.rename(plugin_dir)
            except OSError:
                decky.logger.exception("Update replacement failed, attempting rollback")
                if moved_existing and plugin_dir.exists():
                    shutil.rmtree(plugin_dir)
                if moved_existing and backup_dir.exists() and not plugin_dir.exists():
                    backup_dir.rename(plugin_dir)
                if staging_dir.exists():
                    shutil.rmtree(staging_dir)
                raise
            
            decky.logger.info("Update installation complete!")
            return {
                "installedVersion": self._package_version(plugin_dir / "package.json"),
                "backupPath": str(backup_dir),
            }

    def _find_extracted_plugin(self, root: Path) -> Path | None:
        for candidate in [root, *root.iterdir()]:
            if not candidate.is_dir():
                continue
            if (candidate / "plugin.json").exists() and (candidate / "package.json").exists():
                return candidate
        return None

    def _validate_extracted_plugin(self, plugin_path: Path) -> None:
        manifest_path = plugin_path / "plugin.json"
        package_path = plugin_path / "package.json"
        frontend_path = plugin_path / "dist" / "index.js"
        backend_path = plugin_path / "main.py"

        for required_path in [manifest_path, package_path, frontend_path, backend_path]:
            if not required_path.exists():
                raise ValueError(f"release zip is missing {required_path.relative_to(plugin_path)}")

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"release plugin.json is invalid: {error}") from error

        if str(manifest.get("name", "")) != "Decky Task Manager":
            raise ValueError("release zip is not Decky Task Manager")

        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"release package.json is invalid: {error}") from error

        if not package.get("version"):
            raise ValueError("release package.json does not contain a version")

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

    def _schedule_loader_restart(self, reason: str) -> dict[str, Any]:
        decky.logger.info("Scheduling Decky Loader restart: %s", reason)

        unit = f"decky-task-manager-restart-{int(time.time())}"
        commands = [
            {
                "method": "systemd-run-user",
                "argv": [
                    "systemd-run",
                    "--user",
                    "--on-active=2",
                    f"--unit={unit}",
                    "systemctl",
                    "--user",
                    "restart",
                    "plugin_loader.service",
                ],
            },
            {
                "method": "systemd-run-system",
                "argv": [
                    "systemd-run",
                    "--on-active=2",
                    f"--unit={unit}",
                    "systemctl",
                    "restart",
                    "plugin_loader.service",
                ],
            },
        ]

        for command in commands:
            try:
                result = subprocess.run(
                    command["argv"],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                decky.logger.warning("%s restart scheduling failed: %s", command["method"], error)
                continue

            if result.returncode == 0:
                decky.logger.info("Restart scheduled with %s", command["method"])
                return {
                    "scheduled": True,
                    "method": command["method"],
                    "message": "Decky Loader restart scheduled.",
                }

            decky.logger.warning(
                "%s exited %s: %s",
                command["method"],
                result.returncode,
                result.stderr.strip()[-160:],
            )

        fallback = self._schedule_loader_restart_helper()
        if fallback["scheduled"]:
            return fallback

        decky.logger.error("All restart methods failed - manual restart required")
        return {
            "scheduled": False,
            "method": "",
            "message": "Could not schedule Decky Loader restart.",
        }

    def _schedule_loader_restart_helper(self) -> dict[str, Any]:
        helper_path = Path(tempfile.gettempdir()) / f"decky-task-manager-restart-{os.getpid()}-{int(time.time())}.sh"
        helper = """#!/usr/bin/env bash
sleep 2
systemctl --user restart plugin_loader.service \
  || systemctl --user restart plugin_loader \
  || systemctl restart plugin_loader.service \
  || systemctl restart plugin_loader
rm -f "$0"
"""

        try:
            helper_path.write_text(helper, encoding="utf-8")
            helper_path.chmod(0o755)
            command = f"nohup {shlex.quote(str(helper_path))} >/dev/null 2>&1 &"
            result = subprocess.run(
                ["bash", "-lc", command],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            decky.logger.warning("Helper restart scheduling failed: %s", error)
            return {"scheduled": False, "method": "helper", "message": str(error)}

        if result.returncode != 0:
            decky.logger.warning("Helper restart scheduling exited %s: %s", result.returncode, result.stderr.strip()[-160:])
            try:
                helper_path.unlink(missing_ok=True)
            except OSError:
                pass
            return {
                "scheduled": False,
                "method": "helper",
                "message": result.stderr.strip()[-160:],
            }

        return {
            "scheduled": True,
            "method": "helper",
            "message": "Decky Loader restart helper started.",
        }

    def _cleanup_previous_update_artifacts(self) -> None:
        plugin_dir = Path(decky.DECKY_PLUGIN_DIR)
        plugin_parent = plugin_dir.parent
        backup_dir = plugin_dir.with_name(f"{plugin_dir.name}.previous")

        for path in [backup_dir, *plugin_parent.glob(f".{plugin_dir.name}.update-*")]:
            if not path.exists():
                continue
            try:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
                decky.logger.info("Removed previous update artifact: %s", path)
            except OSError as error:
                decky.logger.warning("Failed to remove update artifact %s: %s", path, error)
