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
- Threads from every machine: the sidebar reads them from the panel's own T3 page, through Electron's
  debugger on that webview. It lists the machines the panel is connected to (tray: "Connect machines").
  Until the panel has loaded, or while it knows no machine, it lists this PC only.
- The panel keeps its own T3 theme. Change it in the panel's T3 settings.

## Controls

| Action | How |
| --- | --- |
| Focus the composer | `Ctrl+Shift+Space`, or the write button under the chat |
| Hide or show the overlay | `Ctrl+Shift+H` |
| Move | Drag the T3 logo |
| Show more or fewer threads | Drag the sidebar's top or bottom edge |
| Lock position, chat background opacity | Right-click the T3 logo |
| Settle a thread | Right-click its icon |
| Close the panel and return to the game | `Esc` |

Hotkeys and the panel's origin live in the config file (tray: "Edit config").

## When T3 changes its layout

Every selector the overlay relies on is in `src/guest/style.ts`. When a T3 nightly renames one,
the T3 logo shows a warning dot and that file needs updating.
