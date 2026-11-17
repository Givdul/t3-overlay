import type { PanelApprovalDecision, PanelAttachment, PanelMessageContext } from "../shared/panel";
import type { T3Server } from "./t3";

// Client for T3's Effect RPC socket (effect/unstable/rpc, JSON serialization). One frame is a JSON
// object or an array of them. Every stream Chunk must be acked, or the server stops after a handful
// of chunks. A connection carries any number of streams and unary calls, each keyed by its request id.
//
// `connect` is generic over the request reply type, and `stream` over one stream's value: each caller
// names the slice of T3's contract it reads, and that caller decodes it. Nothing here inspects a payload.

/** The request payloads this client sends; T3's RPC contracts name the same fields. */
export interface WirePayload {
  threadId?: string;
  afterSequence?: number;
  requestCompletionMarker?: boolean;
  itemId?: string;
  // `orchestration.dispatchCommand`: T3's command type and its fields sit at the top level.
  type?: string;
  commandId?: string;
  messageId?: string;
  text?: string;
  attachments?: PanelAttachment[];
  // `attachments.createUploadUrl` asks for one upload slot; its `type` selects image or file.
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdBy?: string;
  creationSource?: string;
  dispatchMode?: { type: string };
  // `thread.model-selection.set`: the model the thread's next turn runs on.
  modelSelection?: { instanceId: string; model: string };
  // `orchestration.launchThread`: the new-thread draft's project, title and first turn.
  projectId?: string;
  title?: string;
  generateTitle?: boolean;
  runtimeMode?: string;
  interactionMode?: string;
  workspaceStrategy?: { type: string };
  initialMessage?: { messageId: string; text: string; attachments: PanelAttachment[] };
  runId?: string;
  snoozedUntil?: string;
  requestId?: string;
  decision?: PanelApprovalDecision;
  answers?: Record<string, string | string[]>;
  // `queued-run.edit` carries the queued message's own context, so an edit keeps its `@`-mentions.
  context?: PanelMessageContext;
}

/** A thread command for T3's orchestration engine (packages/contracts, OrchestrationCommand). */
export type ThreadCommand =
  | {
      type: "message.dispatch";
      threadId: string;
      messageId: string;
      text: string;
      attachments: PanelAttachment[];
      createdBy: "user";
      creationSource: "web";
      dispatchMode: { type: "start_immediately" } | { type: "queue_after_active" };
    }
  | { type: "thread.stop"; threadId: string }
  /** The queued message a user cancels or rewrites (packages/contracts/src/orchestrationV2.ts). */
  | { type: "queued-run.cancel"; threadId: string; runId: string }
  | {
      type: "queued-run.edit";
      threadId: string;
      runId: string;
      text: string;
      attachments?: PanelAttachment[];
      /** The queued message's composer context, which replacing its text must not drop. */
      context?: PanelMessageContext;
    }
  | {
      type: "thread.model-selection.set";
      threadId: string;
      modelSelection: { instanceId: string; model: string };
    }
  | { type: "thread.settle"; threadId: string }
  | { type: "thread.snooze"; threadId: string; snoozedUntil: string }
  | {
      type: "runtime-request.respond";
      threadId: string;
      requestId: string;
      decision?: PanelApprovalDecision;
      answers?: Record<string, string | string[]>;
    };

/** A command frame's payload: T3's command fields plus the id that makes it idempotent. */
export function commandFrame(command: ThreadCommand): WirePayload {
  return { commandId: crypto.randomUUID(), ...command };
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

type ServerFrame<R> =
  | { _tag: "Chunk"; requestId: string | number; values: unknown[] }
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

/** T3's socket open timeout; a connect that never opens counts as a failed attempt (packages/client-runtime/src/rpc/session.ts, SOCKET_OPEN_TIMEOUT). */
const SOCKET_OPEN_TIMEOUT_MS = 15_000;

export interface T3Rpc<R> {
  /** One stream on the shared socket; its caller names the value type it decodes (T3's `V`). */
  stream<V>(tag: string, payload: WirePayload, handlers: StreamHandlers<V>): () => void;
  /** `T` is one of the reply shapes this connection's caller reads; T3 answers it on the Exit frame. */
  request<T extends R>(tag: string, payload: WirePayload): Promise<T>;
  /** A command: T3 answers it with no value, and the call resolves once it has accepted it. */
  command(tag: string, payload: WirePayload): Promise<void>;
  close(): void;
}

/** Opens one authenticated socket to the T3 server. Throws AuthExpiredError when T3 rejects the token. */
export async function connect<R>(server: T3Server, token: string): Promise<T3Rpc<R>> {
  const url = new URL("/ws", server.origin.replace(/^http/, "ws"));
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", await websocketTicket(server, token));
  const socket = new WebSocket(url);

  let nextRequest = 0;
  let closed = false;
  const streams = new Map<string, StreamHandlers<unknown>>();
  const requests = new Map<string, { resolve: (value: R | undefined) => void; reject: (error: Error) => void }>();
  // Armed once the socket opens: a refused connect never creates a timer to leak.
  let ping: NodeJS.Timeout | undefined;

  // A connect that neither opens nor errors would otherwise wait for the OS, and its caller would never
  // retry. The timeout closes the half-open socket and fails like a refused connect, so the caller's own
  // backoff (main/backoff.ts) retries it.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Fail with the timeout first: closing a half-open socket can also raise its own error.
      reject(new Error(`T3 did not open the socket within ${SOCKET_OPEN_TIMEOUT_MS / 1000}s`));
      socket.close();
    }, SOCKET_OPEN_TIMEOUT_MS);

    const settle = (error?: Error) => {
      clearTimeout(timeout);

      if (error === undefined) resolve();
      else reject(error);
    };

    socket.addEventListener("open", () => settle(), { once: true });
    socket.addEventListener("error", () => settle(new Error("socket error")), { once: true });
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
    // envelope, and the payload values stay typed by the caller's stream until it decodes them.
    const parsed = JSON.parse(String(event.data)) as ServerFrame<R> | ServerFrame<R>[];

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

  function call(tag: string, payload: WirePayload): Promise<R | undefined> {
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
    stream<V>(tag: string, payload: WirePayload, handlers: StreamHandlers<V>) {
      const id = String(++nextRequest);
      // SAFETY: this request's frames are the V values its caller named; the map keeps them erased.
      streams.set(id, handlers as StreamHandlers<unknown>);
      send({ _tag: "Request", id, tag, payload, headers: [] });

      return () => {
        if (!streams.delete(id)) return;

        // T3 ends the request on its side too, or the stream would keep reading into the socket.
        send({ _tag: "Interrupt", requestId: id });
        handlers.onClose("stream stopped");
      };
    },
    async request<T extends R>(tag: string, payload: WirePayload): Promise<T> {
      // SAFETY: T is one of this connection's reply shapes (T extends R), and T3's Exit frame carries
      // exactly that reply for the tag this caller chose.
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
  // A server that accepts the request and never answers would hold `connect` past the socket-open
  // timeout, so the caller's backoff would never run. The ticket gets the same budget the socket has.
  const timeout = () => AbortSignal.timeout(SOCKET_OPEN_TIMEOUT_MS);
  let response = await fetch(`${server.origin}/api/auth/websocket-ticket/rpc`, { method: "POST", headers, signal: timeout() });

  if (response.status === 404) {
    response = await fetch(`${server.origin}/api/auth/websocket-ticket`, { method: "POST", headers, signal: timeout() });
  }

  if (response.status === 401) throw new AuthExpiredError("T3 rejected the overlay session");

  if (!response.ok) throw new Error(`websocket ticket failed: ${response.status}`);

  // SAFETY: both ticket routes answer with a ticket, as T3's own web client reads them.
  const { ticket } = (await response.json()) as { ticket: string };

  return ticket;
}

/** Sends one command on a short connection and resolves once T3 has accepted it. */
export async function dispatchCommand(server: T3Server, token: string, command: ThreadCommand): Promise<void> {
  const rpc = await connect<never>(server, token);
  let timeout: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${command.type}: no answer from T3`)), 10_000);
      rpc.command("orchestration.dispatchCommand", commandFrame(command)).then(resolve, reject);
    });
  } finally {
    clearTimeout(timeout);
    rpc.close();
  }
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
