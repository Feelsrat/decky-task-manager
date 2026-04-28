# Decky Task Manager

Decky Task Manager is a small Decky Loader plugin for checking what the rest of your plugins are doing without leaving the quick access menu.

It has two main areas:

- Plugin errors: scans Decky plugin logs when you press refresh and counts lines that look like errors, exceptions, tracebacks, failures, or crashes.
- System and plugins: shows a quick CPU and RAM snapshot, lists installed Decky plugins, and gives you a disable button for each one.

Nothing in here runs as a background service. It only reads logs, reads `/proc`, or updates Decky settings when you open the panel or press a button.

## Why

Decky plugins are brilliant, but when one starts misbehaving it can be annoying to work out which one is making noise in the logs. This is meant to be a quick first look: which plugins are throwing errors, how loaded the Deck is right now, and which plugin you might want to disable before digging deeper.

## Notes

- Disabling a plugin writes to Decky Loader's `disabled_plugins` setting and schedules a quick `plugin_loader.service` restart so the change applies.
- Decky Task Manager will not disable itself.
- The error count is a log scan, not a crash reporter. It is intentionally simple and may count noisy warning-style lines if a plugin logs them with words like `failed` or `error`.
- The plugin uses Decky's root flag because it needs to read Decky settings and restart Decky Loader.
