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

function mintToken(): Promise<string> {
  const cli = join(T3_HOME, "bin", process.platform === "win32" ? "t3.cmd" : "t3");
  const args = ["auth", "session", "issue", "--ttl", "90d", "--label", "t3-overlay", "--token-only"];
  return new Promise((resolve, reject) => {
    // .cmd shims run through cmd.exe. The arguments are fixed, so nothing is interpolated.
    const [file, fileArgs] =
      process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", `"${cli}" ${args.join(" ")}`]] : [cli, args];
    execFile(file, fileArgs, { timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true }, (error, stdout) => {
      const token = stdout.trim().split(/\r?\n/).pop() ?? "";
      if (error || token === "") reject(error ?? new Error("t3 auth session issue printed no token"));
      else resolve(token);
    });
  });
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
    token = await mintToken();
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
