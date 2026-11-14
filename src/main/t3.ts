import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";

const T3_HOME = join(homedir(), ".t3");

/** One T3 server the overlay talks to, as its environment descriptor names it. */
export interface T3Server {
  origin: string;
  /** The environment this server is, as threads on it name it. */
  environmentId: string;
  label: string;
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

/** The server at `origin`, by its environment descriptor. Throws when nothing there answers as T3. */
export async function readDescriptor(origin: string): Promise<T3Server> {
  const response = await fetch(new URL("/.well-known/t3/environment", origin), { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) throw new Error(`${origin} answered ${response.status}`);
  // SAFETY: T3's environment descriptor always names its environmentId; the label is optional.
  const { environmentId, label } = (await response.json()) as { environmentId: string; label?: string };

  return { origin: new URL(origin).origin, environmentId, label: label ?? "T3 environment" };
}

/** This PC's server, from the runtime file T3 writes while it runs. */
export async function readServer(): Promise<T3Server | null> {
  try {
    const raw = JSON.parse(await readFile(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"));

    // The file outlives the server. Without a live server process, whatever answers on its old port
    // would receive the session token.
    if (!isAlive(raw.pid)) return null;

    return await readDescriptor(raw.origin);
  } catch {
    return null;
  }
}

const tokenPath = () => join(app.getPath("userData"), "t3-session.bin");

/** `t3 auth session issue`'s flags for the shell's session: the scope `/ws` and the HTTP API accept. */
const SESSION_ARGS = ["auth", "session", "issue", "--ttl", "90d", "--label", "t3-overlay", "--token-only"];

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
    // .cmd shims run through cmd.exe. The arguments are fixed, so the joined string carries no command.
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

/** Whether T3 at `server` still takes `token`. */
export async function isAuthenticated(server: T3Server, token: string): Promise<boolean> {
  const response = await fetch(`${server.origin}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  // SAFETY: T3's session route answers with its AuthSessionState; only `authenticated` is read.
  return response.ok && ((await response.json()) as { authenticated: boolean }).authenticated;
}

let pendingSession: { key: string; token: Promise<string> } | null = null;

/**
 * Returns a working bearer token for this PC's server. Concurrent calls for the same server and mint
 * share one attempt, so a reconnect racing an expiry mints one token, not two. Other calls run after it.
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

  if (token === null || !(await isAuthenticated(server, token))) {
    token = await mintToken(SESSION_ARGS);

    if (!(await isAuthenticated(server, token))) throw new Error("T3 rejected a freshly minted session token");

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
