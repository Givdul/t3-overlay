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

export async function openShellStream(server: T3Server, token: string, handlers: StreamHandlers): Promise<() => void> {
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
  const socket = new WebSocket(url);
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
