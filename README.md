# t3-overlay

An always-on-top T3 Code overlay for gaming. It shows a thin, movable sidebar of thread icons
and a chat panel that is T3's own web UI with the extra chrome hidden. Nothing in T3 is forked,
so updating T3 updates the panel.

## Run

```sh
npm install
npm run build
npm start
```

Play the game in a borderless or windowed mode. Exclusive fullscreen hides the overlay.

## How it connects

- Reads the local T3 server from `~/.t3/userdata/server-runtime.json`.
- Mints its own session once with `t3 auth session issue --ttl 90d` and stores it with `safeStorage`.
- Copies `~/.t3/userdata/client-settings.json` into the panel on start, so send shortcut and
  follow-up behavior match the desktop app.
- Threads from every machine: start T3 with `--remote-debugging-port=9333` (tray: "Launch T3 with
  overlay support"). The overlay reads T3's own thread cache and live socket frames over CDP.
  Without the port it lists this PC only and the tray icon shows a warning.
  While that port is open, any local program can control T3.

## Controls

| Action | How |
| --- | --- |
| Focus the composer | `Ctrl+Shift+Space`, or the write button under the chat |
| Hide or show the overlay | `Ctrl+Shift+H` |
| Move | Drag the T3 logo |
| Lock position, chat background opacity | Right-click the T3 logo |
| Settle a thread | Right-click its icon |
| Close the panel and return to the game | `Esc` |

Hotkeys and the debugging port live in the config file (tray: "Edit config").

## When T3 changes its layout

Every selector the overlay relies on is in `src/guest/style.ts`. When a T3 nightly renames one,
the T3 logo shows a warning dot and that file needs updating.
