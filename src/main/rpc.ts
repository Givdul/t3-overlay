import type { T3Server } from "./t3";

// Minimal client for T3's Effect RPC socket (effect/unstable/rpc, JSON serialization).
// One frame is a JSON object or an array of them. Every stream Chunk must be acked,
// or the server stops after a handful of chunks.

type ServerFrame =
  | { _tag: "Chunk"; requestId: string | number; values: unknown[] }
  | { _tag: "Exit"; requestId: string | number; exit: { _tag: "Success" | "Failure"; cause?: unknown; value?: unknown } }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "Pong" }
  | { _tag: string };

export class AuthExpiredError extends Error {}

export interface StreamHandlers {
  onValue: (value: unknown) => void;
  onClose: (reason: string) => void;
}

async function openSocket(server: T3Server, token: string): Promise<WebSocket> {
  const ticketResponse = await fetch(`${server.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (ticketResponse.status === 401) throw new AuthExpiredError("T3 rejected the overlay session");
  if (!ticketResponse.ok) throw new Error(`websocket ticket failed: ${ticketResponse.status}`);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };

  const url = new URL("/ws", server.origin.replace(/^http/, "ws"));
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket);

  return new WebSocket(url);
}

export async function openShellStream(server: T3Server, token: string, handlers: StreamHandlers): Promise<() => void> {
  const socket = await openSocket(server, token);
  let closed = false;
  const ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('{"_tag":"Ping"}'), 10_000);

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "orchestration.subscribeShell",
        payload: {},
        headers: [],
      }),
    );
  });
  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data)) as ServerFrame | ServerFrame[];
    for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
      if (frame._tag === "Chunk" && "values" in frame) {
        socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
        for (const value of frame.values) handlers.onValue(value);
      } else if (frame._tag === "Exit" || frame._tag === "Defect") {
        socket.close();
        finish(`stream ended: ${JSON.stringify(frame).slice(0, 300)}`);
      }
    }
  });
  socket.addEventListener("close", () => finish("socket closed"));
  socket.addEventListener("error", () => finish("socket error"));

  function finish(reason: string) {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    handlers.onClose(reason);
  }

  return () => {
    closed = true;
    clearInterval(ping);
    socket.close();
  };
}

/** A thread command for T3's orchestration engine (packages/contracts, OrchestrationCommand). */
export type ThreadCommand = { type: "thread.snooze"; threadId: string; snoozedUntil: string };

/** Sends one command and resolves once T3 has accepted it. */
export async function dispatchCommand(server: T3Server, token: string, command: ThreadCommand): Promise<void> {
  const socket = await openSocket(server, token);
  let timeout: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${command.type}: no answer from T3`)), 10_000);
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "orchestration.dispatchCommand",
            payload: { ...command, commandId: crypto.randomUUID() },
            headers: [],
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        // SAFETY: T3's RPC socket sends a JSON frame or an array of them.
        const parsed = JSON.parse(String(event.data)) as ServerFrame | ServerFrame[];

        for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
          if (frame._tag === "Exit" && "exit" in frame && frame.exit._tag === "Success") resolve();
          else if (frame._tag === "Exit" || frame._tag === "Defect") reject(new Error(`${command.type} failed: ${JSON.stringify(frame).slice(0, 300)}`));
        }
      });
      socket.addEventListener("close", () => reject(new Error(`${command.type}: socket closed`)));
      socket.addEventListener("error", () => reject(new Error(`${command.type}: socket error`)));
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}
