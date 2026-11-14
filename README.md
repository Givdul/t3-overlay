# t3-overlay

An always-on-top T3 Code overlay for gaming. It shows a thin, movable sidebar of thread icons and a
chat panel drawn by the overlay itself, reading the open thread from T3 Code: this PC's server, and
the machines it is linked to. Nothing in T3 is forked, so updating T3 updates the overlay with it.

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
- Stop: the stop button interrupts the active run.
- Answer: approval and question cards resolve the request in the thread.
- Settle and snooze from a thread's right-click menu. Both go through T3's own commands.
- Open in T3: the title row hands the thread to the T3 Code app (`t3code://threads/...`). The `+`
  button opens T3's new-thread composer for the newest thread's project.

The panel keeps the overlay's own look: the chat background opacity, the message-bubble opacity and
the text outline settings all apply to it.

## Other machines

The sidebar also lists the threads of the machines this PC's T3 Code is linked to. Opening one shows
its history, the machine it is on, and **Open in T3**. Those threads are read-only for now: send,
stop, approvals, settle and snooze stay in T3 Code.

T3 Code reaches another machine over a peer link, and the overlay reads it through this PC's server.
Both are needed:

- a link on this PC: `t3 environment link` (T3 Code's Machines settings do the same),
- Settings → Labs → **Linked environments** turned on.

A machine that does not answer is noted in the logo's tooltip, and its threads are not listed until
it answers again.

## Deliberate losses

The panel is a thin client, not T3's page. Some actions are only in T3 Code; the title row's
**Open in T3** opens the same thread there:

- starting a thread with a picked model or permission mode (the `+` button opens T3's composer),
- `/` slash commands and `@` file mentions,
- attachments and pasted images,
- dictation.

A thread on another machine has its history and **Open in T3**, and nothing that writes to it.

## How it connects

- Reads the local T3 server from `~/.t3/userdata/server-runtime.json` and checks its pid is alive
  before trusting the port.
- Mints its own session once with `t3 auth session issue --ttl 90d` and keeps it sealed with
  `safeStorage`. The token stays in the main process: the renderer only ever sees typed thread events
  and sends commands back.
- Mints a second, read-only session for T3's `/mcp` endpoint (`--subject mcp-client --scope
  orchestration:read`), sealed in its own file, to read the other machines' threads through this
  PC's server.
- Every URL is built from that pid-verified server origin. This PC's thread rows come from the
  server's shell stream; the other machines' come from its `/mcp` endpoint.

## Controls

| Action | How |
| --- | --- |
| Focus the composer | `Ctrl+Shift+Space`, or the write button under the chat |
| Hide or show the overlay | `Ctrl+Shift+H` |
| Move | Drag the T3 logo |
| Show more or fewer threads | Drag the sidebar's top or bottom edge |
| Lock position, chat background opacity, text outline, bubbles | Right-click the T3 logo |
| Settle or snooze a thread | Right-click its icon |
| Close the panel and return to the game | `Esc` |

Hotkeys live in the config file (tray: "Edit config").
