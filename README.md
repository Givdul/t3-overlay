# t3-overlay

An always-on-top T3 Code overlay for gaming. It shows a thin, movable sidebar of thread icons and a
chat panel drawn by the overlay itself, reading threads from T3 Code: this PC's server, and any other
machine paired with the overlay. Nothing in T3 is forked, so updating T3 updates the overlay with it.

## Run

```sh
npm install
npm run build
npm start
```

Play the game in a borderless or windowed mode. Exclusive fullscreen hides the overlay.

## What the panel can do

- Read: the thread's title, its markdown and code timeline, running commands as they stream, and its
  status. Every message, command, file change, plan and notice T3's own timeline shows is drawn here.
- Send: Enter starts a turn, or queues behind the active run while one is going. Shift+Enter is a
  newline.
- Attach: paste, drop or pick files. Images go up to 10 MB and other files to 50 MB, T3's limits.
- `@` searches the thread's checkout for files and inserts a link to the picked one, as T3 does.
- `/` lists the provider's commands and skills. `/clear` starts the next message without the
  thread's earlier context.
- Stop: the stop button interrupts the active run.
- Answer: approval and question cards resolve the request in the thread.
- Settle and snooze from a thread's right-click menu. Both go through T3's own commands.
- Open in T3: the title row hands the thread to the T3 Code app (`t3code://threads/...`).

The panel keeps the overlay's own look: the chat background opacity, the message-bubble opacity and
the text outline settings all apply to it.

## New threads

The `+` button opens a new-thread composer with T3's own choices:

- the machine and the project,
- the model and its options, such as reasoning effort,
- the permission mode,
- local or a new worktree, the branch or the worktree's base branch, and whether the worktree starts
  from origin.

It starts from the project's defaults in that machine's T3 settings, and from the machine, project
and model of the last thread started here. Sending starts the thread with one
`orchestration.launchThread`, as T3's composer does: T3 creates the worktree and names its branch. A
local thread on another branch switches the project's checkout to it first, as T3's branch picker
does. The panel then opens on the new thread.

## Other machines

The overlay is a client of each machine's T3 server, the way T3 Code's own window is. Pair a machine
once:

1. On that machine, open T3 Code's Settings → Sharing & access and create a link, or run
   `t3 pair --tailscale`.
2. Copy the link, then choose **Pair a machine from the clipboard…** in the overlay's tray menu.
3. Confirm the machine's name and address. The overlay spends the one-time code there.

The machine has to be reachable from this PC by that address: on the same network with T3's network
access on, or over Tailscale. T3 Connect's relay only serves T3's own apps.

A paired machine's threads list beside this PC's, live, and everything the panel and the new-thread
composer do works there too. T3 issues the session for 30 days with no refresh. When it ends, the
logo's tooltip says the machine needs pairing again. **Forget** in the tray deletes the session on
this PC. T3 does not let a session revoke itself, so revoke `t3-overlay` in that machine's Settings →
Sharing & access to end it there.

## Deliberate losses

The panel is a thin client, not T3's page. Some actions are only in T3 Code; the title row's
**Open in T3** opens the same thread there:

- dictation,
- `@` mentions of threads, machines and pull requests, and T3's `/side`, `/btw` and `/model`.

## How it connects

- Reads the local T3 server from `~/.t3/userdata/server-runtime.json` and checks its pid is alive
  before trusting the port.
- Mints its own session there once with `t3 auth session issue --ttl 90d` and keeps it sealed with
  `safeStorage`.
- Exchanges a paired machine's one-time code at its `/oauth/token` for a bearer session, sealed in
  its own file with the address it was paired over. Before sending the token, the overlay checks that
  address still answers as the same T3 environment.
- Every token stays in the main process: the renderer only ever sees typed thread events and sends
  commands back. Each machine gets one shell socket for its thread rows and the composer's calls, and
  one socket for the open thread.

## Controls

| Action | How |
| --- | --- |
| Focus the composer | `Ctrl+Shift+Space`, or the write button under the chat |
| Start a thread | The `+` button |
| Hide or show the overlay | `Ctrl+Shift+H` |
| Move | Drag the T3 logo |
| Show more or fewer threads | Drag the sidebar's top or bottom edge |
| Lock position, chat background opacity, text outline, bubbles | Right-click the T3 logo |
| Settle or snooze a thread | Right-click its icon |
| Pair or forget a machine | The tray menu |
| Close the panel and return to the game | `Esc` |

Hotkeys live in the config file (tray: "Edit config").
