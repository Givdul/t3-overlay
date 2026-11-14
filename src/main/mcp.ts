import type { T3Server } from "./t3";

// Client for T3's MCP endpoint: the Streamable HTTP transport of protocol 2025-06-18. One POST per
// JSON-RPC message; T3 answers with JSON or with an SSE stream, and the session id from initialize
// rides on every later message. Hand-rolled like rpc.ts, so the overlay keeps its few dependencies.

const PROTOCOL_VERSION = "2025-06-18";

/** A T3 that stops answering must not stall the poller that owns this client. */
const REQUEST_TIMEOUT_MS = 20_000;

/** The arguments the read-only tools take: ids, page sizes and flags. */
export type ToolArguments = Record<string, string | number | boolean>;

/** T3 rejected the session, so the token it was opened with has to be minted again. */
export class McpAuthExpiredError extends Error {}

/** T3's tool failed: a machine that does not answer, a thread that is gone, links turned off. */
export class McpToolError extends Error {}

interface InitializeRequest {
  jsonrpc: "2.0";
  id: number;
  method: "initialize";
  params: {
    protocolVersion: string;
    capabilities: Record<string, boolean>;
    clientInfo: { name: string; version: string };
  };
}

interface CallRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: { name: string; arguments: ToolArguments };
}

interface Notification {
  jsonrpc: "2.0";
  method: string;
}

type JsonRpcRequest = InitializeRequest | CallRequest | Notification;

interface Reply {
  id?: number | string | null;
  error?: { message?: string };
  result?: ToolResult;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type?: string; text?: string }[];
}

export interface Mcp {
  /** One tool's `structuredContent`. Throws McpToolError when T3's tool fails. */
  callTool<T>(name: string, args?: ToolArguments): Promise<T>;
}

/**
 * A client for this server's MCP endpoint. The URL is built from the pid-verified origin, where the
 * token goes and nowhere else. It initializes on the first call, and again once when T3 answers 404
 * because it restarted or dropped the session.
 */
export function openMcp(server: T3Server, token: string): Mcp {
  const endpoint = `${server.origin}/mcp`;
  let sessionId: string | null = null;
  let initialized = false;
  let nextId = 0;

  async function post(message: JsonRpcRequest): Promise<Response> {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });

    // The transport's session headers start once initialize has answered.
    if (sessionId !== null) {
      headers.set("mcp-session-id", sessionId);
      headers.set("mcp-protocol-version", PROTOCOL_VERSION);
    }

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function initialize(): Promise<void> {
    const id = nextId++;

    const response = await post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-overlay", version: "0.1.0" },
      },
    });

    rejectExpired(response);

    if (!response.ok) throw new Error(`MCP initialize failed: HTTP ${response.status}`);

    const reply = replyFor(await replies(response), id);

    if (reply.error !== undefined) throw new McpToolError(reply.error.message ?? "MCP initialize failed");

    sessionId = response.headers.get("mcp-session-id");
    initialized = true;

    // The protocol asks for this notification once initialize has answered. T3 answers 202, no body.
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });

    rejectExpired(ack);
    await ack.body?.cancel();
  }

  async function callTool<T>(name: string, args: ToolArguments = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (!initialized) await initialize();

      const id = nextId++;
      const response = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

      rejectExpired(response);

      // T3 forgot the session: initialize once, then send the same call again.
      if (response.status === 404 && attempt === 0) {
        sessionId = null;
        initialized = false;
        continue;
      }

      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

      const reply = replyFor(await replies(response), id);

      if (reply.error !== undefined) throw new McpToolError(`${name}: ${reply.error.message ?? "request failed"}`);

      return toolOutput<T>(name, reply.result);
    }
  }

  return { callTool };
}

function rejectExpired(response: Response): void {
  if (response.status === 401) throw new McpAuthExpiredError("T3 rejected the MCP session");
}

/** The JSON-RPC messages in a response body: JSON is one, an SSE stream keeps one per event. */
async function replies(response: Response): Promise<Reply[]> {
  if (response.status === 202 || response.status === 204) return [];

  const body = await response.text();

  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // SAFETY: a JSON transport response is one JSON-RPC message, as in T3's own client
    // (mcpResponsePayloads.ts); nothing else is typed off this body.
    return body.trim() === "" ? [] : [JSON.parse(body) as Reply];
  }

  // SAFETY: each SSE event's `data:` lines join into one JSON-RPC message, the same rule T3's own
  // client applies; comments and other fields carry nothing this client reads.
  return body.split(/(?:\r\n|\r|\n){2}/).flatMap((event) => {
    const data = event
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    // SAFETY: the event's data is one JSON-RPC message, as the split above leaves it.
    return data === "" ? [] : [JSON.parse(data) as Reply];
  });
}

function replyFor(replies: Reply[], id: number): Reply {
  const reply = replies.find((candidate) => candidate.id === id);

  // A reply to another request says nothing about this one, and T3 echoes the id on every reply.
  if (reply === undefined) throw new Error(`MCP answered no reply for request ${id}`);

  return reply;
}

function toolOutput<T>(name: string, result: ToolResult | undefined): T {
  if (result?.isError === true) throw new McpToolError(`${name}: ${failureText(result)}`);

  // SAFETY: T names the tool's own result shape, which main/remote.ts types from the fields T3's
  // contract declares; T3 puts exactly that shape in `structuredContent` when a tool succeeds.
  return result?.structuredContent as T;
}

/** T3 returns a declared failure as `isError`, with its message as the only content block. */
function failureText(result: ToolResult): string {
  const text = result.content?.find((block) => block.type === "text")?.text;

  return text === undefined || text === "" ? "the tool failed" : text.slice(0, 300);
}
