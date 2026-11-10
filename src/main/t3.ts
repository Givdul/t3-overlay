import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, safeStorage, session } from "electron";

export const T3_PARTITION = "persist:t3";

const T3_HOME = join(homedir(), ".t3");

export interface T3Server {
  origin: string;
  port: number;
  serverVersion: string;
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
    return { origin: raw.origin, port: raw.port, serverVersion: raw.serverVersion };
  } catch {
    return null;
  }
}

const tokenPath = () => join(app.getPath("userData"), "t3-session.bin");

async function loadToken(): Promise<string | null> {
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
  auth: { sessionCookieName: string };
}

async function authSession(server: T3Server, token: string): Promise<AuthSession> {
  const response = await fetch(`${server.origin}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()) as AuthSession;
}

/** The server the session cookie was last installed for. It stays set while that server is down. */
let cookieServer: URL | null = null;

/**
 * Cookies ignore ports, so the session cookie also rides on requests to every other listener on the
 * T3 server's host. Whether `url` is one of them.
 */
export function isOtherPortOfSessionHost(url: string): boolean {
  if (cookieServer === null || !URL.canParse(url)) return false;

  const target = new URL(url);

  return target.hostname === cookieServer.hostname && target.port !== cookieServer.port;
}

let pendingSession: Promise<string> | null = null;

/**
 * Returns a working bearer token and installs it as the session cookie of the T3 webview partition.
 * Concurrent callers share one attempt, so a reconnect racing an expiry mints one token, not two.
 */
export function ensureSession(server: T3Server, forceMint = false): Promise<string> {
  pendingSession ??= establishSession(server, forceMint).finally(() => {
    pendingSession = null;
  });

  return pendingSession;
}

async function establishSession(server: T3Server, forceMint: boolean): Promise<string> {
  let token = forceMint ? null : await loadToken();
  let current = token === null ? null : await authSession(server, token);
  if (token === null || current === null || !current.authenticated) {
    token = await mintToken();
    current = await authSession(server, token);
    if (!current.authenticated) throw new Error("T3 rejected a freshly minted session token");

    // Without an OS keychain the token lives only in memory, and the next start mints another.
    if (safeStorage.isEncryptionAvailable()) await writeFile(tokenPath(), await safeStorage.encryptStringAsync(token));
  }
  await session.fromPartition(T3_PARTITION).cookies.set({
    url: server.origin,
    name: current.auth.sessionCookieName,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: Date.now() / 1000 + 90 * 24 * 3600,
  });
  cookieServer = new URL(server.origin);

  return token;
}

/** Copies the desktop app's client settings (send shortcut, follow-up behavior, theme) into the webview. */
export async function readDesktopClientSettings(): Promise<string | null> {
  try {
    return await readFile(join(T3_HOME, "userdata", "client-settings.json"), "utf8");
  } catch {
    return null;
  }
}
