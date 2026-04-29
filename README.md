# Decky Task Manager

A lightweight Decky Loader plugin for monitoring your other plugins without leaving the quick access menu.

The plugin has three tabs. The Overview tab shows system CPU and RAM usage, along with which plugins are currently running and how much resources they're using. The Plugins tab lets you enable or disable any plugin with a single tap. The Logs tab scans error messages from plugin logs and groups similar ones together so you can see which plugins are having issues.

Live monitoring can be toggled on to watch CPU and RAM metrics in real time. When it's off, you get a snapshot of the last values. The plugin does micro-sampling every second when live monitoring is enabled, taking four quick samples to catch brief CPU spikes that might otherwise be missed. Testing mode clears all logs, resets metric peaks, and starts fresh monitoring so you can reproduce a problem cleanly. !!! DO NOT LEAVE THIS ON !!! (probably idk, havent tested it that much yet)

Updates can be checked and installed directly from the plugin once a new release is available on GitHub.

## Why

Decky plugins are great, but when one starts acting up it can be hard to figure out which one is causing problems. This plugin gives you a quick first look at what's going on: which plugins are throwing errors, how loaded your Deck is, and which plugins you might want to disable before investigating further.

## Notes

Disabling a plugin writes to Decky Loader's disabled_plugins setting and triggers a plugin_loader service restart to apply the change immediately. Decky Task Manager won't let you disable itself.

The error count comes from scanning log files, not from a crash reporter. It's intentionally simple and might count warning messages if a plugin logs them with words like "failed" or "error" in them.

The plugin requires root permissions because it needs to read Decky settings and restart the plugin loader service.

## Install

Download the latest release ZIP and install it through Decky's developer mode in the settings menu.

## Development

Install dependencies and build the plugin with pnpm. Use `pnpm install` to get started, then `pnpm run build` to compile. Run `pnpm run watch` if you want automatic rebuilds during development. The test command validates Python syntax, TypeScript compilation, and required files before you release.

To create a new release, make sure you have the GitHub CLI installed and authenticated with `gh auth login`. Then run `pnpm run release` which will bump the version, run tests, build everything, package it into a ZIP, and push a new release to GitHub.

## TODO (If I feel like maintaining this)

- Create a list of known errors for common plugins and alert the user if errors are serious
- alert user if logs are being hit constantly by a plugin every x secs and stuff like that
- fix the auto updater, disabled for now but was creating zombie processes and not clearing previous instances on decky refresh
  

