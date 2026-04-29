# Decky Task Manager

A lightweight Decky Loader plugin for monitoring your other plugins without leaving the quick access menu.

The plugin has three tabs. The Overview tab shows system CPU and RAM usage, along with which plugins are currently running and how much resources they're using. It also surfaces serious log alerts when live monitoring finds them. The Plugins tab lets you enable, disable, or kill the running processes for a plugin with a single tap. The Logs tab scans error messages from plugin logs, groups similar ones together, ranks known serious failures, and flags plugins that are writing to logs constantly.

Live monitoring can be toggled on to watch CPU and RAM metrics in real time, and it keeps running in the backend if you close the quick access menu. When it's off, you get a snapshot of the last values. The plugin does micro-sampling every second when live monitoring is enabled, taking four quick samples to catch brief CPU spikes that might otherwise be missed. Each plugin tracks current CPU/RAM and max CPU/RAM since the last metric reset, so short spikes remain visible after the current value drops. Testing mode clears all logs and metric peaks, then starts fresh monitoring so you can reproduce a problem cleanly. !!! DO NOT LEAVE THIS ON !!! (probably idk, havent tested it that much yet)

Updates can be checked and installed directly from the plugin once a new release is available on GitHub. Update installation requires Decky root permissions, stages and validates the downloaded release, replaces the plugin directory, updates the reported version, and schedules a Decky Loader restart so the new files and backend process are picked up.

## Why

Decky plugins are great, but when one starts acting up it can be hard to figure out which one is causing problems. This plugin gives you a quick first look at what's going on: which plugins are throwing errors, how loaded your Deck is, and which plugins you might want to disable before investigating further. Personally I was having an issue with Muradeck on my steam deck oled (Bazzite) which was causing fps issues when I would have any ui rendered ontop of a game e.g. fps counter or tweaking volume.

## Notes

Disabling a plugin writes to Decky Loader's disabled_plugins setting and triggers a plugin_loader service restart to apply the change immediately. Killing a plugin process sends SIGTERM first, then SIGKILL if the process is still running shortly afterward. Decky Task Manager won't let you disable or kill itself.

The error count comes from scanning log files, not from a crash reporter. It's intentionally simple and might count warning messages if a plugin logs them with words like "failed" or "error" in them. Known serious patterns currently include Python tracebacks, out-of-memory failures, permission failures, missing dependencies, syntax/startup failures, disk write failures, config parse failures, network/API failures, and Steam UI/API failures.

The plugin requires root permissions because it needs to read Decky settings and restart the plugin loader service.

Auto update checks on plugin startup are disabled for now. Manual update checks and installs are available from the UI.

## Install

Download the latest release ZIP and install it through Decky's developer mode in the settings menu.

## Development

Install dependencies and build the plugin with pnpm. Use `pnpm install` to get started, then `pnpm run build` to compile. Run `pnpm run watch` if you want automatic rebuilds during development.

Run `pnpm run test` before releasing. It validates Python syntax, lightweight backend behavior mocks, the frontend build, TypeScript project types, the manifest, and required package files.

Useful focused checks:

- `pnpm run test:backend` runs the lightweight backend mock tests for QAM-style monitoring persistence, current/max metrics, and plugin kill signaling.
- `pnpm run test:types` runs the TypeScript type check.
- `pnpm run build` rebuilds `dist/index.js`.

Smoke-test updater replacement/restart on a Steam Deck before publishing a public release.

To create a new release, make sure you have the GitHub CLI installed and authenticated with `gh auth login`. Then run `pnpm run release` which will bump the version, run tests, build everything, package it into a ZIP, and create a new release on GitHub. Use `pnpm run release -- --private` to create a draft release for review before publishing it.

