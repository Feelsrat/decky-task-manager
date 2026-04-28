# Decky Task Manager

Decky Task Manager is a small Decky Loader plugin for checking what the rest of your plugins are doing without leaving the quick access menu.

It has two main areas:

- Plugin errors: scans Decky plugin logs, groups similar error lines, and lets you clear logs before testing something again.
- System and plugins: shows CPU and RAM, maps usage back to plugin processes where Decky exposes enough info, and keeps the disable button beside each plugin.

There is also a fullscreen view if the QAM feels too cramped. Live monitoring only runs while the panel or fullscreen page is open and switched on.

## Why

Decky plugins are brilliant, but when one starts misbehaving it can be annoying to work out which one is making noise in the logs. This is meant to be a quick first look: which plugins are throwing errors, how loaded the Deck is right now, and which plugin you might want to disable before digging deeper.

## Notes

- Disabling a plugin writes to Decky Loader's `disabled_plugins` setting and schedules a quick `plugin_loader.service` restart so the change applies.
- Decky Task Manager will not disable itself.
- The error count is a log scan, not a crash reporter. It is intentionally simple and may count noisy warning-style lines if a plugin logs them with words like `failed` or `error`.
- The plugin uses Decky's root flag because it needs to read Decky settings and restart Decky Loader.
