import type { T3Server } from "./t3";

// Client for T3's Effect RPC socket (effect/unstable/rpc, JSON serialization).
// One frame is a JSON object or an array of them. Every stream Chunk must be acked, or the server
// stops sending after a handful of chunks. One socket carries one shell feed, one thread
// subscription and any number of unary calls.
//
// `connect` is generic over the stream value and request reply types: each caller names the slice of
// T3's contract it reads, and main decodes it there. Nothing here inspects a payload.

/** The request payloads this client sends; T3's RPC contracts name the same fields. */
export interface WirePayload {
  threadId?: string;
  afterSequence?: number;
  requestCompletionMarker?: boolean;
  itemId?: string;
  // `orchestration.dispatchCommand`: T3's command type and its fields sit at the top level.
  type?: string;
  commandId?: string;
  snoozedUntil?: string;
  // The commands the panel dispatches.
  runtimeMode?: string;
  interactionMode?: string;
  messageId?: string;
  createdBy?: string;
  text?: string;
  attachments?: unknown[];
  modelSelection?: unknown;
  dispatchMode?: { type: string };
  freshContext?: boolean;
  requestId?: string;
  decision?: string;
  answers?: Record<string, string | string[]>;
  visitedAt?: string;
  opened?: boolean;
  // `projects.searchEntries`
  cwd?: string;
  query?: string;
  limit?: number;
  // `orchestration.launchThread`
  creationSource?: string;
  projectId?: string;
  title?: string;
  generateTitle?: boolean;
  workspaceStrategy?: { type: string };
  initialMessage?: unknown;
}

/** A client frame: a request, an ack or a ping. */
interface WireFrame {
  _tag: string;
  id?: string;
  tag?: string;
  payload?: WirePayload;
  headers?: string[];
  requestId?: string | number;
}

type ServerFrame<V, R> =
  | { _tag: "Chunk"; requestId: string | number; values: V[] }
  | { _tag: "Exit"; requestId: string | number; exit: Exit<R> }
  | { _tag: "Defect"; defect?: string }
  | { _tag: "Pong" }
  | { _tag: string };

interface Exit<R> {
  _tag: "Success" | "Failure";
  /** A unary reply: T3 answers on the Exit frame, with the reply type the caller named. */
  value?: R;
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

export interface T3Rpc<V, R> {
  stream(tag: string, payload: WirePayload, handlers: StreamHandlers<V>): () => void;
  /** `T` is one of the reply shapes this connection's caller reads; T3 answers it on the Exit frame. */
  request<T extends R>(tag: string, payload: WirePayload): Promise<T>;
  close(): void;
}

/** Opens one authenticated socket to the T3 server. Throws AuthExpiredError when T3 rejects the token. */
export async function connect<V, R>(server: T3Server, token: string): Promise<T3Rpc<V, R>> {
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

  let nextRequest = 0;
  let closed = false;
  const streams = new Map<string, StreamHandlers<V>>();
  const requests = new Map<string, { resolve: (value: R) => void; reject: (error: Error) => void }>();
  const ping = setInterval(() => send({ _tag: "Ping" }), 10_000);

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });

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
    const parsed = JSON.parse(String(event.data)) as ServerFrame<V, R> | ServerFrame<V, R>[];

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

  function onExit(requestId: string, exit: Exit<R>) {
    if (exit._tag === "Success") {
      const handlers = streams.get(requestId);

      if (handlers !== undefined) {
        streams.delete(requestId);
        handlers.onClose("stream completed");

        return;
      }

      const pending = requests.get(requestId);
      requests.delete(requestId);

      if (pending !== undefined && exit.value !== undefined) pending.resolve(exit.value);

      return;
    }

    const message = failureMessage(exit.cause);
    const handlers = streams.get(requestId);

    if (handlers !== undefined) {
      streams.delete(requestId);
      handlers.onClose(message);

      return;
    }

    requests.get(requestId)?.reject(new Error(message));
    requests.delete(requestId);
  }

  const rpc: T3Rpc<V, R> = {
    stream(tag, payload, handlers) {
      const id = String(++nextRequest);
      streams.set(id, handlers);
      send({ _tag: "Request", id, tag, payload, headers: [] });

      return () => {
        if (!streams.delete(id)) return;

        handlers.onClose("stream stopped");
      };
    },
    request<T extends R>(tag: string, payload: WirePayload) {
      const id = String(++nextRequest);

      return new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new Error("not connected"));

          return;
        }

        // SAFETY: T is one of this connection's reply shapes (T extends R), and T3's Exit frame
        // carries exactly that reply for the tag this caller chose.
        requests.set(id, { resolve: (value) => resolve(value as T), reject });
        send({ _tag: "Request", id, tag, payload, headers: [] });
      });
    },
    close() {
      finish("connection closed");
      socket.close();
    },
  };

  return rpc;
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

/** A thread command for T3's orchestration engine (packages/contracts, OrchestrationCommand). */
export type ThreadCommand =
  | { type: "thread.snooze"; threadId: string; snoozedUntil: string }
  | { type: "thread.settle"; threadId: string };

/** Sends one command over the same client the panel uses and resolves once T3 has accepted it. */
export async function dispatchCommand(server: T3Server, token: string, command: ThreadCommand): Promise<void> {
  // Held by reference: the connection is made inside the timer's promise, and a timeout's late answer
  // still needs closing. A plain `let` would narrow to null in the finally block.
  const opened: T3Rpc<never, unknown>[] = [];
  let timeout: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${command.type}: no answer from T3`)), 10_000);
      void connect<never, unknown>(server, token)
        .then((rpc) => {
          opened.push(rpc);

          return rpc.request("orchestration.dispatchCommand", { ...command, commandId: crypto.randomUUID() });
        })
        .then(() => resolve(), reject);
    });
  } finally {
    clearTimeout(timeout);

    for (const rpc of opened) rpc.close();
  }
}
