import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";

const T3_HOME = join(homedir(), ".t3");

export interface T3Server {
  origin: string;
  port: number;
  serverVersion: string;
  /** The environment this server is, as threads on it name it. */
  environmentId: string;
}

/** Whether `pid` is a running process this user may signal. Another user's process counts as not running. */
export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

export async function readServer(): Promise<T3Server | null> {
  try {
    const raw = JSON.parse(await readFile(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"));

    // The file outlives the server. Without a live server process, whatever answers on its old port
    // would receive the session token.
    if (!isAlive(raw.pid)) return null;
    const response = await fetch(`${raw.origin}/.well-known/t3/environment`);
    if (!response.ok) return null;
    // SAFETY: T3's environment descriptor always names its environmentId.
    const { environmentId } = (await response.json()) as { environmentId: string };

    return { origin: raw.origin, port: raw.port, serverVersion: raw.serverVersion, environmentId };
  } catch {
    return null;
  }
}

const tokenPath = () => join(app.getPath("userData"), "t3-session.bin");
const mcpTokenPath = () => join(app.getPath("userData"), "t3-mcp-session.bin");

/** `t3 auth session issue`'s flags for the shell's session: the scope `/ws` and the HTTP API accept. */
const SESSION_ARGS = ["auth", "session", "issue", "--ttl", "90d", "--label", "t3-overlay", "--token-only"];

/**
 * The `/mcp` session. `mcp-client` is the one subject T3's MCP endpoint accepts, and it needs both
 * scopes: reading the other machines' threads, and acting on them.
 */
const MCP_SESSION_ARGS = [
  "auth",
  "session",
  "issue",
  "--ttl",
  "90d",
  "--label",
  "t3-overlay-remote",
  "--subject",
  "mcp-client",
  "--scope",
  "orchestration:read",
  "--scope",
  "orchestration:operate",
  "--token-only",
];

/** The last token this process minted or loaded, so a session without an OS keychain isn't minted again per reconnect. */
let knownToken: string | null = null;

async function loadToken(): Promise<string | null> {
  if (knownToken !== null) return knownToken;

  if (!existsSync(tokenPath())) return null;

  // A corrupt file, or one sealed by another keychain, would otherwise fail every reconnect. A fresh token replaces it.
  try {
    return (await safeStorage.decryptStringAsync(await readFile(tokenPath()))).result;
  } catch {
    return null;
  }
}

function runT3(args: string[]): Promise<string> {
  const cli = join(T3_HOME, "bin", process.platform === "win32" ? "t3.cmd" : "t3");
  return new Promise((resolve, reject) => {
    // .cmd shims run through cmd.exe. The arguments are fixed, and every session id is checked
    // against /^[\w-]+$/ first, so the joined string carries no command.
    const [file, fileArgs] =
      process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", `"${cli}" ${args.join(" ")}`]] : [cli, args];
    execFile(file, fileArgs, { timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function mintToken(args: string[]): Promise<string> {
  const token = (await runT3(args)).trim().split(/\r?\n/).pop() ?? "";

  if (token === "") throw new Error("t3 auth session issue printed no token");

  return token;
}

interface AuthSession {
  authenticated: boolean;
}

async function authSession(server: T3Server, token: string): Promise<AuthSession> {
  const response = await fetch(`${server.origin}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()) as AuthSession;
}

let pendingSession: { key: string; token: Promise<string> } | null = null;

/**
 * Returns a working bearer token for the server. Concurrent calls for the same server and mint share
 * one attempt, so a reconnect racing an expiry mints one token, not two. Other calls run after it.
 */
export function ensureSession(server: T3Server, forceMint = false): Promise<string> {
  const key = `${server.origin} ${forceMint}`;

  if (pendingSession?.key === key) return pendingSession.token;

  const before = pendingSession?.token.catch(() => null) ?? Promise.resolve(null);

  const token = before
    .then(() => establishSession(server, forceMint))
    .finally(() => {
      if (pendingSession?.token === token) pendingSession = null;
    });

  pendingSession = { key, token };

  return token;
}

async function establishSession(server: T3Server, forceMint: boolean): Promise<string> {
  let token = forceMint ? null : await loadToken();
  let current = token === null ? null : await authSession(server, token);
  if (token === null || current === null || !current.authenticated) {
    token = await mintToken(SESSION_ARGS);
    current = await authSession(server, token);
    if (!current.authenticated) throw new Error("T3 rejected a freshly minted session token");

    await saveToken(token);
  }

  knownToken = token;

  return token;
}

/** Without an OS keychain, or when the user declines it, the token lives only in memory and the next start mints another. */
async function saveToken(token: string) {
  if (!safeStorage.isEncryptionAvailable()) return;

  try {
    await writeFile(tokenPath(), await safeStorage.encryptStringAsync(token));
  } catch (error) {
    console.warn("[t3] keeping the session token in memory only", error);
  }
}

/**
 * The MCP session serves one environment: a token minted for another T3 belongs to another machine.
 * Where it came from decides whether it may act; only the token's owner knows its scopes, so the file
 * records that this one holds both.
 */
interface McpSession {
  environmentId: string;
  token: string;
  scopes: "read+operate";
}

let knownMcpSession: McpSession | null = null;

/** Set when the sealed session predates remote actions, so the mint replaces and revokes it. */
let staleMcpSession = false;

async function loadMcpSession(server: T3Server): Promise<string | null> {
  if (knownMcpSession !== null) return knownMcpSession.environmentId === server.environmentId ? knownMcpSession.token : null;

  if (!existsSync(mcpTokenPath())) return null;

  // As with the shell's token, a corrupt file or one sealed by another keychain is replaced.
  try {
    // SAFETY: saveMcpSession writes this shape, sealed with safeStorage.
    const stored = JSON.parse((await safeStorage.decryptStringAsync(await readFile(mcpTokenPath()))).result) as Partial<McpSession>;

    if (stored.environmentId !== server.environmentId || stored.token === undefined) return null;

    // A session sealed before actions existed is read-only. Its token still reads, but T3 will refuse
    // every write with it, so this start mints one with both scopes and revokes the old session.
    if (stored.scopes !== "read+operate") {
      staleMcpSession = true;

      return null;
    }

    knownMcpSession = { environmentId: server.environmentId, token: stored.token, scopes: "read+operate" };

    return stored.token;
  } catch {
    return null;
  }
}

async function saveMcpSession(environmentId: string, token: string) {
  if (!safeStorage.isEncryptionAvailable()) return;

  const session: McpSession = { environmentId, token, scopes: "read+operate" };

  try {
    await writeFile(mcpTokenPath(), await safeStorage.encryptStringAsync(JSON.stringify(session)));
  } catch (error) {
    console.warn("[t3] keeping the MCP session in memory only", error);
  }
}

interface AuthSessionRecord {
  sessionId: string;
  subject: string;
  scopes: string[];
  client?: { label?: string };
}

/**
 * The first P4 start replaces the read-only session with one that may act. Both carry the same label,
 * and only one must remain, so the read-only ones are revoked rather than left valid for 90 days.
 */
async function revokeReadOnlyMcpSessions() {
  try {
    // SAFETY: `t3 auth session list --json` prints these records (binCli's session list command).
    const sessions = JSON.parse(await runT3(["auth", "session", "list", "--json"])) as AuthSessionRecord[];

    for (const session of sessions) {
      if (session.subject !== "mcp-client" || session.client?.label !== "t3-overlay-remote") continue;

      if (session.scopes.includes("orchestration:operate")) continue;

      // .cmd shims run through cmd.exe, where this id would be a command: only an id T3 prints gets through.
      if (!/^[\w-]+$/.test(session.sessionId)) {
        throw new Error(`t3 auth session list printed an id the CLI cannot take: ${session.sessionId}`);
      }

      await runT3(["auth", "session", "revoke", session.sessionId]);
    }
  } catch (error) {
    // The new session works; an old one that outlives it is not worth failing the connection over.
    console.warn("[t3] revoking the read-only MCP session failed", error);
  }
}

let pendingMcpSession: { key: string; token: Promise<string> } | null = null;

/**
 * Returns the token T3's MCP endpoint takes, minting it once. It cannot be checked against
 * `/api/auth/session`, which refuses this subject, so a token T3 no longer knows shows up as a 401
 * from the endpoint and `forceMint` replaces it. Concurrent calls share one attempt, as ensureSession's do.
 */
export function ensureMcpSession(server: T3Server, forceMint = false): Promise<string> {
  const key = `${server.environmentId} ${forceMint}`;

  if (pendingMcpSession?.key === key) return pendingMcpSession.token;

  const before = pendingMcpSession?.token.catch(() => null) ?? Promise.resolve(null);

  const token = before
    .then(() => establishMcpSession(server, forceMint))
    .finally(() => {
      if (pendingMcpSession?.token === token) pendingMcpSession = null;
    });

  pendingMcpSession = { key, token };

  return token;
}

async function establishMcpSession(server: T3Server, forceMint: boolean): Promise<string> {
  let token = forceMint ? null : await loadMcpSession(server);

  if (token === null) {
    const replacingReadOnly = staleMcpSession;

    staleMcpSession = false;
    token = await mintToken(MCP_SESSION_ARGS);
    await saveMcpSession(server.environmentId, token);

    if (replacingReadOnly) await revokeReadOnlyMcpSessions();
  }

  knownMcpSession = { environmentId: server.environmentId, token, scopes: "read+operate" };

  return token;
}
