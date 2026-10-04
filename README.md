# Decky Task Manager

A lightweight Decky Loader plugin for monitoring your other plugins without leaving the quick access menu.

The plugin has three tabs. The Overview tab opens with a health summary, CPU and RAM tiles with recent history, the plugins using the most resources, and any plugins that need attention. Tap a plugin to jump straight to its details or logs. The Plugins tab groups plugins into running, idle and disabled. Selecting one shows its current and peak CPU/RAM along with Disable/Enable, Stop and Logs actions. Disabling and stopping ask for confirmation first. The Logs tab ranks plugins by severity. Selecting one shows the known problems found, the most frequent error lines, and how fast the log is growing.

Live monitoring can be toggled on to watch CPU and RAM metrics in real time, and it keeps running in the backend if you close the quick access menu. When it's off, you get a snapshot of the last values. The plugin does micro-sampling every second when live monitoring is enabled, taking four quick samples to catch brief CPU spikes that might otherwise be missed. Each plugin tracks current CPU/RAM and max CPU/RAM since the last metric reset, so short spikes remain visible after the current value drops. Testing mode clears all logs and metric peaks, then starts fresh monitoring so you can reproduce a problem cleanly. !!! DO NOT LEAVE THIS ON !!! (probably idk, havent tested it that much yet)

Updates can be checked and installed directly from the plugin once a new release is available on GitHub. Downloads use verified HTTPS. Update installation requires Decky root permissions, stages and validates the downloaded release, replaces the plugin directory, updates the reported version, and schedules a Decky Loader restart so the new files and backend process are picked up.

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

### Previewing the UI without a Steam Deck

`pnpm run preview` serves the plugin at http://localhost:5173 inside a mock Quick Access Menu. `@decky/ui`, `@decky/api` and the Python backend are swapped for browser stand-ins in `preview/`, so you can click through every tab with fake data. The arrow keys act as the D-pad, Enter is A and Escape is B. Like Steam, Left/Right only move within rows marked `flow-children="horizontal"`, so controller navigation problems show up here too.

Switch data with `?scenario=issues` (default), `healthy`, `busy` or `empty`. Add `&tall=1` to show the whole panel without scrolling.

`pnpm run preview:shots` saves screenshots of each scenario to `preview/screenshots/` using the pre-installed Chromium or the path in `CHROMIUM_PATH`.

The mock only approximates Steam's styling. Custom pieces (cards, meters, charts) use inline styles and should look the same on a Deck, but Decky components such as buttons and toggles get Steam's real styles there. Check new layouts on hardware before releasing.

Smoke-test updater replacement/restart on a Steam Deck before publishing a public release.

To create a new release, make sure you have the GitHub CLI installed and authenticated with `gh auth login`. Then run `pnpm run release` which will bump the version, run tests, build everything, package it into a ZIP, and create a new release on GitHub. Use `pnpm run release -- --private` to create a draft release for review before publishing it.

Releases can also be published from GitHub Actions: bump the version in `package.json`, commit, then push an annotated tag that matches it (`git tag -a v0.1.20 -m "release notes" && git push origin v0.1.20`). The workflow runs the tests, builds the ZIP, and publishes the release using the tag message as the notes. You can also run the Release workflow by hand from the Actions tab on `main`. It tags the commit with the version in `package.json` and uses the notes you enter.

## TODO

- Check for feasibility of drawing an overlay when monitoring is enabled
- Confirm the redesigned UI (tab bar, expandable plugin rows, Disable/Stop/Logs buttons, confirm dialogs) works with the physical controls on a Steam Deck
