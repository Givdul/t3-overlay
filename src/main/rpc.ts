import type { T3Server } from "./t3";

// Client for T3's Effect RPC socket (effect/unstable/rpc, JSON serialization). One frame is a JSON
// object or an array of them. Every stream Chunk must be acked, or the server stops after a handful
// of chunks. Each connection carries one stream plus any number of unary calls on that socket.
//
// `connect` is generic over the stream value type, and each request names its reply type: every caller
// names the slice of T3's contract it reads, and that caller decodes it. Nothing here inspects a payload.

/** An uploaded attachment as a message carries it (packages/contracts chatAttachment.ts, ChatAttachment). */
export interface WireAttachment {
  type: "image" | "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** A thread command for T3's orchestration engine (packages/contracts, OrchestrationCommand). */
export type ThreadCommand =
  | {
      type: "message.dispatch";
      threadId: string;
      messageId: string;
      text: string;
      attachments: WireAttachment[];
      createdBy: "user";
      creationSource: "web";
      dispatchMode: { type: "start_immediately" } | { type: "queue_after_active" };
      freshContext?: true;
    }
  | { type: "run.interrupt"; threadId: string; runId: string }
  | { type: "thread.settle"; threadId: string }
  | { type: "thread.snooze"; threadId: string; snoozedUntil: string }
  | {
      type: "runtime-request.respond";
      threadId: string;
      requestId: string;
      decision?: "accept" | "decline";
      answers?: Record<string, string | string[]>;
    };

/** A command frame's payload: T3's command fields plus the id that makes it idempotent. */
export function commandFrame(command: ThreadCommand): object {
  return { commandId: crypto.randomUUID(), ...command };
}

/** A client frame: a request, an ack or a ping. The payload is the tag's request, as T3's contract names it. */
interface WireFrame {
  _tag: string;
  id?: string;
  tag?: string;
  payload?: object;
  headers?: string[];
  requestId?: string | number;
}

type ServerFrame<V> =
  | { _tag: "Chunk"; requestId: string | number; values: V[] }
  | { _tag: "Exit"; requestId: string | number; exit: Exit }
  | { _tag: "Defect"; defect?: string }
  | { _tag: "Pong" }
  | { _tag: string };

interface Exit {
  _tag: "Success" | "Failure";
  /** A unary reply: T3 answers on the Exit frame, with the reply type the caller named. */
  value?: unknown;
  cause?: Cause[];
}

interface Cause {
  _tag?: string;
  error?: { message?: string };
  defect?: string;
}

export class AuthExpiredError extends Error {}

export interface StreamHandlers<V> {
  onValue: (value: V) => void;
  /** The stream ended or the socket closed. Called once per stream. */
  onClose: (reason: string) => void;
}

/** The unary half of a connection, which the shell feed and the panel both lend to the composer. */
export interface T3Requests {
  /** `T` is the reply T3's contract names for `tag`; T3 answers it on the Exit frame. */
  request<T>(tag: string, payload: object): Promise<T>;
  /** A command: T3 answers it with no value, and the call resolves once it has accepted it. */
  command(tag: string, payload: object): Promise<void>;
}

export interface T3Rpc<V> extends T3Requests {
  stream(tag: string, payload: object, handlers: StreamHandlers<V>): () => void;
  close(): void;
}

/** Opens one authenticated socket to the T3 server. Throws AuthExpiredError when T3 rejects the token. */
export async function connect<V>(server: T3Server, token: string): Promise<T3Rpc<V>> {
  const url = new URL("/ws", server.origin.replace(/^http/, "ws"));
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", await websocketTicket(server, token));
  const socket = new WebSocket(url);

  let nextRequest = 0;
  let closed = false;
  const streams = new Map<string, StreamHandlers<V>>();
  const requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  // Armed once the socket opens: a refused connect never creates a timer to leak.
  let ping: NodeJS.Timeout | undefined;

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });

  ping = setInterval(() => send({ _tag: "Ping" }), 10_000);

  function send(frame: WireFrame) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function finish(reason: string) {
    if (closed) return;
    closed = true;
    clearInterval(ping);

    for (const handlers of streams.values()) handlers.onClose(reason);
    streams.clear();

    for (const pending of requests.values()) pending.reject(new Error(reason));
    requests.clear();
  }

  socket.addEventListener("message", (event) => {
    // SAFETY: T3 sends JSON in the frames above (effect/unstable/rpc); the fields read here are its
    // envelope, and the payload values stay typed by the caller's V until it decodes them.
    const parsed = JSON.parse(String(event.data)) as ServerFrame<V> | ServerFrame<V>[];

    for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
      if (frame._tag === "Chunk" && "values" in frame) {
        send({ _tag: "Ack", requestId: frame.requestId });
        const handlers = streams.get(String(frame.requestId));

        for (const value of frame.values) handlers?.onValue(value);
      } else if (frame._tag === "Exit" && "exit" in frame) {
        onExit(String(frame.requestId), frame.exit);
      } else if ("defect" in frame) {
        const reason = `T3 reported a defect: ${String(frame.defect).slice(0, 300)}`;

        socket.close();
        finish(reason);
      }
    }
  });
  socket.addEventListener("close", () => finish("T3 closed the connection"));
  socket.addEventListener("error", () => finish("socket error"));

  function onExit(requestId: string, exit: Exit) {
    if (exit._tag === "Failure") {
      const message = failureMessage(exit.cause);
      const handlers = streams.get(requestId);

      if (handlers !== undefined) {
        streams.delete(requestId);
        handlers.onClose(message);

        return;
      }

      requests.get(requestId)?.reject(new Error(message));
      requests.delete(requestId);

      return;
    }

    const handlers = streams.get(requestId);

    if (handlers !== undefined) {
      streams.delete(requestId);
      handlers.onClose("stream completed");

      return;
    }

    const pending = requests.get(requestId);
    requests.delete(requestId);
    // A command's Success carries no `value`; T3 has accepted it either way.
    pending?.resolve(exit.value);
  }

  function call(tag: string, payload: object): Promise<unknown> {
    const id = String(++nextRequest);

    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("not connected"));

        return;
      }

      requests.set(id, { resolve, reject });
      send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  return {
    stream(tag, payload, handlers) {
      const id = String(++nextRequest);
      streams.set(id, handlers);
      send({ _tag: "Request", id, tag, payload, headers: [] });

      return () => {
        if (!streams.delete(id)) return;

        handlers.onClose("stream stopped");
      };
    },
    async request<T>(tag: string, payload: object): Promise<T> {
      // SAFETY: T3's Exit frame carries the reply its contract names for this tag, and the caller names
      // that reply as T (or the slice of it it reads).
      return (await call(tag, payload)) as T;
    },
    async command(tag, payload) {
      await call(tag, payload);
    },
    close() {
      finish("connection closed");
      socket.close();
    },
  };
}

/**
 * A ticket is bound to the route that uses it, as in T3's own web client. Older servers only have the bare
 * route, which issues one for any route and answers 404 on the scoped one.
 */
async function websocketTicket(server: T3Server, token: string): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  let response = await fetch(`${server.origin}/api/auth/websocket-ticket/rpc`, { method: "POST", headers });

  if (response.status === 404) response = await fetch(`${server.origin}/api/auth/websocket-ticket`, { method: "POST", headers });

  if (response.status === 401) throw new AuthExpiredError("T3 rejected the overlay session");

  if (!response.ok) throw new Error(`websocket ticket failed: ${response.status}`);

  // SAFETY: both ticket routes answer with a ticket, as T3's own web client reads them.
  const { ticket } = (await response.json()) as { ticket: string };

  return ticket;
}

/** T3's RPC failures carry an Effect cause; the message is the useful part. */
function failureMessage(causes: Cause[] | undefined): string {
  for (const cause of causes ?? []) {
    if (cause._tag === "Fail") {
      const message = cause.error?.message;

      if (message !== undefined && message !== "") return message;

      return JSON.stringify(cause.error).slice(0, 300);
    }

    if (cause._tag === "Die") {
      return cause.defect === undefined ? "T3 reported a defect" : cause.defect;
    }
  }

  return "T3 request failed";
}
