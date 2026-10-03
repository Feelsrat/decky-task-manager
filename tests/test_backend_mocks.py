import asyncio
import importlib.util
import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FakeLogger:
    def info(self, *args, **kwargs):
        pass

    def warning(self, *args, **kwargs):
        pass

    def error(self, *args, **kwargs):
        pass

    def exception(self, *args, **kwargs):
        pass


def load_main_module():
    decky = types.SimpleNamespace(
        DECKY_HOME="",
        DECKY_PLUGIN_DIR="",
        logger=FakeLogger(),
    )
    sys.modules["decky"] = decky

    module_name = "decky_task_manager_main_for_mock_tests"
    sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(module_name, ROOT / "main.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load main.py")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    module.decky = decky
    return module


class BackendMockTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.module = load_main_module()

    async def test_monitoring_state_survives_mock_qam_remount(self):
        plugin = self.module.Plugin()
        calls = 0

        async def collect_metrics():
            nonlocal calls
            calls += 1
            return {
                "timestamp": time.time(),
                "cpu": 1.0,
                "memory": {"used": 100, "total": 1000, "percent": 10.0},
                "plugins": [],
                "history": [],
            }

        plugin._collect_metrics = collect_metrics

        enabled_state = await plugin.set_monitoring(True)
        reopened_state = await plugin.get_monitoring_state()
        await plugin.set_monitoring(False)

        self.assertTrue(enabled_state["enabled"])
        self.assertTrue(reopened_state["enabled"])
        self.assertIsNotNone(reopened_state["metrics"])
        self.assertGreaterEqual(calls, 1)

    async def test_plugin_metrics_keep_current_and_max_values_until_reset(self):
        plugin = self.module.Plugin()
        plugin._previous_cpu = (0, 1000)
        plugin._previous_processes = {123: 100}

        first = plugin._plugin_metrics(
            [{"pid": 123, "name": "Sample Plugin", "cpu_time": 130, "rss": 256000}],
            (0, 1100),
        )[0]
        self.assertEqual(first["cpu"], 30.0)
        self.assertEqual(first["memory"], 250)
        self.assertEqual(first["peakCpu"], 30.0)
        self.assertEqual(first["peakMemory"], 250)
        self.assertTrue(first["spike"])
        self.assertEqual(first["spikeReason"], "cpu")

        plugin._previous_cpu = (0, 1100)
        plugin._previous_processes = {123: 130}
        second = plugin._plugin_metrics(
            [{"pid": 123, "name": "Sample Plugin", "cpu_time": 135, "rss": 768000}],
            (0, 1200),
        )[0]
        self.assertEqual(second["cpu"], 5.0)
        self.assertEqual(second["memory"], 750)
        self.assertEqual(second["peakCpu"], 30.0)
        self.assertEqual(second["peakMemory"], 750)
        self.assertTrue(second["spike"])
        self.assertEqual(second["spikeReason"], "ram")

        await plugin.reset_metrics()
        self.assertEqual(plugin._plugin_resource_peaks, {})

    async def test_kill_plugin_processes_signals_selected_plugin_pids(self):
        plugin = self.module.Plugin()
        plugin._list_plugins = lambda: [
            {"name": "Sample Plugin", "folder": "sample-plugin"},
            {"name": "Other Plugin", "folder": "other-plugin"},
        ]
        plugin._read_plugin_processes = lambda _plugins: [
            {"pid": 111, "name": "Sample Plugin", "cpu_time": 0, "rss": 0},
            {"pid": 222, "name": "Other Plugin", "cpu_time": 0, "rss": 0},
        ]
        plugin._pid_is_running = lambda pid: pid == 111

        kills = []
        original_kill = self.module.os.kill
        original_sleep = self.module.asyncio.sleep

        async def fake_sleep(_seconds):
            pass

        self.module.os.kill = lambda pid, sig: kills.append((pid, sig))
        self.module.asyncio.sleep = fake_sleep
        try:
            result = await plugin.kill_plugin_processes("Sample Plugin")
        finally:
            self.module.os.kill = original_kill
            self.module.asyncio.sleep = original_sleep

        self.assertTrue(result["ok"])
        self.assertEqual(result["terminated"], [111])
        self.assertEqual(result["killed"], [111])
        self.assertEqual([pid for pid, _signal in kills], [111, 111])

    async def test_kill_plugin_processes_refuses_self(self):
        plugin = self.module.Plugin()
        result = await plugin.kill_plugin_processes("Decky Task Manager")

        self.assertFalse(result["ok"])
        self.assertIn("cannot kill itself", result["message"])

    async def test_enable_and_disable_plugin_preserve_other_loader_settings(self):
        plugin = self.module.Plugin()
        plugin._list_plugins = lambda: [{"name": "Sample Plugin", "folder": "sample-plugin"}]
        plugin._schedule_loader_restart = lambda _reason: {"scheduled": False, "method": "", "message": ""}

        with tempfile.TemporaryDirectory() as home:
            self.module.decky.DECKY_HOME = home
            settings_path = Path(home) / "settings" / "loader.json"
            settings_path.parent.mkdir(parents=True)
            settings_path.write_text(json.dumps({"branch": 0, "disabled_plugins": ["Other"]}), encoding="utf-8")

            disabled = await plugin.disable_plugin("Sample Plugin")
            after_disable = json.loads(settings_path.read_text(encoding="utf-8"))
            enabled = await plugin.enable_plugin("Sample Plugin")
            after_enable = json.loads(settings_path.read_text(encoding="utf-8"))

        self.assertTrue(disabled["ok"])
        self.assertTrue(enabled["ok"])
        self.assertEqual(after_disable, {"branch": 0, "disabled_plugins": ["Other", "Sample Plugin"]})
        self.assertEqual(after_enable, {"branch": 0, "disabled_plugins": ["Other"]})

    def test_log_paths_only_match_exact_plugin_names(self):
        plugin = self.module.Plugin()

        with tempfile.TemporaryDirectory() as root:
            log_root = Path(root)
            for relative in [
                "audio/2026-01-01.log",
                "audioloader/2026-01-01.log",
                "audio.log",
                "audioloader.log",
            ]:
                path = log_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")

            paths = plugin._log_paths_for_plugin(
                log_root,
                {"name": "Audio", "folder": "audio"},
                plugin._log_files(log_root),
            )
            relative_paths = sorted(path.relative_to(log_root).as_posix() for path in paths)

        self.assertEqual(relative_paths, ["audio.log", "audio/2026-01-01.log"])

    async def test_failed_update_check_is_not_cached(self):
        plugin = self.module.Plugin()
        plugin._current_version = lambda: "0.1.0"
        plugin._update_last_check_time = lambda: None
        plugin._latest_release = lambda: None

        failed = await plugin.check_update()
        self.assertFalse(failed["ok"])
        self.assertIsNone(plugin._cached_update_status)

        plugin._latest_release = lambda: {
            "tag_name": "v0.2.0",
            "assets": [{"name": "decky-task-manager.zip", "browser_download_url": "https://example.invalid"}],
        }
        recovered = await plugin.check_update()
        self.assertTrue(recovered["ok"])
        self.assertTrue(recovered["hasUpdate"])


if __name__ == "__main__":
    unittest.main()
