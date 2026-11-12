# t3-overlay

An always-on-top T3 Code overlay for gaming: a thin, movable sidebar of thread icons and a chat panel
drawn from the running T3 Code server itself. T3 is not forked or embedded, so updating T3 updates the
panel.

## Run

```sh
npm install
npm run build
npm start
```

Play the game in a borderless or windowed mode. Exclusive fullscreen hides the overlay.

## How it connects

The panel is a thin client of the T3 Code server already running on this Mac. It reads the thread over
T3's own websocket RPC and draws the timeline, composer and cards itself instead of embedding T3's web
UI. One token, one socket, one path: the panel is not a second copy of T3.

- **Where.** `~/.t3/userdata/server-runtime.json` names the server's origin, and the overlay uses it only
  while that file's `pid` is alive. It is local only: the server answers on `127.0.0.1`.
- **The token.** On first start the overlay mints its own T3 session (`t3 auth session issue --ttl 90d
  --label t3-overlay`) and keeps it sealed with the OS keychain (`safeStorage`). It never prints the
  token and never hands it to the page: the main process holds the socket, the renderer gets the thread
  as data over IPC.
- **Reads.** `orchestration.subscribeShell` (this PC's threads), T3's own web UI over its local DevTools
  port (threads from every machine and T3's colours), `orchestration.subscribeThread` plus
  `orchestration.getThreadProjection` (the open thread's timeline, then its live events),
  `server.getConfig` (the composer's models, commands and skills), `projects.searchEntries` (`@` files),
  `orchestration.getTurnItem` (a tool row's full output), and `/ws/voice` for dictation.
- **Sends.** Messages and queued messages, Stop, Approve/Deny, question answers, Settle, Snooze, a new
  thread's launch, and the dictation stream. Every write is a T3 command or request, so the desktop app
  sees it immediately.
- **Remote machines.** Their threads are listed in the sidebar, but the panel cannot read or write them:
  they show an "Open in T3" card. Everything above is this PC only.

Without T3's debug port (`--remote-debugging-port=9333`, tray: "Launch T3 with the debug port") the
sidebar lists this PC only, and the panel falls back to a palette that follows the system appearance.

## Controls

| Action | How |
| --- | --- |
| Focus the composer | `Ctrl+Shift+Space`, or the write button under the chat |
| Hide or show the overlay | `Ctrl+Shift+H` |
| Move | Drag the T3 logo |
| Lock position, chat background opacity | Right-click the T3 logo |
| Settle or snooze a thread | Right-click its icon |
| Dictate into the composer | `⌘⇧D`, or the microphone |
| Close the panel and return to the game | `Esc` |

Hotkeys and the debugging port live in the config file (tray: "Edit config").

## Deliberate losses

The panel does less than T3's web UI. It does not show the chat header (branch, PR, details), the right
panel, preview and terminal drawers, the plan-mode toggle, or side chats (`/side`, `/btw`). It does not
support thread, machine or pull-request mentions (file `@` mentions are in), or clicking a mentioned file
to reveal it in an editor. Message editing, rollback, reply redo and forks are out, as is editing a queued
message before its run starts. There are no model favourites or multi-model runs, no prompt-injected
effort preset such as `ultrathink` (the chip sends effort as a model option), no stash, no provider
status banners, no token meter and no notifications. Attachments other than pasted images are out, as
are math, mermaid diagrams, T3 asset images, force-stop, and agent-requested secrets or machine links
(those arrive as one muted line). Switching threads clears the composer, so there are no per-thread
drafts. Code is coloured with the panel's own small fixed palette rather than T3's, timestamps follow the
OS locale rather than `settings.timestampFormat`, and the `/` menu always lists the provider's skills.
