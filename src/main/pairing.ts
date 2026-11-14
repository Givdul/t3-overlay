import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { readDescriptor, type T3Server } from "./t3";

// Another machine's T3, reached directly the way T3 Code's own window does: a one-time pairing code
// from that machine is exchanged for a bearer session there (packages/client-runtime authorization/remote.ts).
// The session lives sealed on this PC and is sent only to the origin it was paired over.

/** A machine paired from a pairing link, with the session its T3 issued to this overlay. */
export interface PairedMachine {
  server: T3Server;
  token: string;
  /** Epoch ms. T3 issues paired sessions without a refresh: past this the machine is paired again. */
  expiresAt: number;
}

/** A pairing link read, and the server it names, before its one-time code is spent. */
export interface PairingTarget {
  server: T3Server;
  code: string;
}

/**
 * The origin and code in any link `t3 pair` or Settings → Sharing & access prints: the direct
 * `<host>/pair#token=<code>`, the hosted `https://app.t3.codes/pair?host=<backend>#token=<code>`, and the
 * `t3code://pair?pairingUrl=<link>` app link around either (packages/shared/src/remote.ts).
 */
export function parsePairingLink(text: string): { origin: string; code: string } | null {
  const value = text.trim();

  if (!URL.canParse(value)) return null;
  let url = new URL(value);

  if (/^t3code(?:-[a-z]+)?:$/.test(url.protocol) && url.host === "pair") {
    const inner = url.searchParams.get("pairingUrl")?.trim() ?? "";

    if (!URL.canParse(inner)) return null;
    url = new URL(inner);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const code = (hash.get("token") ?? url.searchParams.get("token") ?? "").trim();

  if (code === "") return null;

  // A hosted link names the backend in `host`; T3 reads a bare host there as https.
  const host = url.searchParams.get("host")?.trim();
  const backend = host ? (/^[a-z]+:\/\//i.test(host) ? host : `https://${host}`) : url.origin;

  if (!URL.canParse(backend)) return null;

  return { origin: new URL(backend).origin, code };
}

/** Reads the descriptor of the server a link names, so the user sees which machine it is before pairing. */
export async function resolvePairing(link: { origin: string; code: string }): Promise<PairingTarget> {
  return { server: await readDescriptor(link.origin), code: link.code };
}

interface TokenResult {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Spends the one-time code at `/oauth/token` for a bearer session on that machine. */
export async function redeemPairing(target: PairingTarget): Promise<PairedMachine> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: target.code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "t3-overlay",
    client_device_type: "desktop",
    client_os: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
  });

  const response = await fetch(`${target.server.origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${target.server.label} refused the pairing code (${response.status}). Pairing codes work once and expire after 5 minutes.`);
  }

  // SAFETY: T3's token route answers with AuthAccessTokenResult (packages/contracts auth.ts).
  const result = (await response.json()) as TokenResult;

  // A DPoP token is bound to a key this client does not hold; only T3 Connect issues those.
  if (result.token_type !== "Bearer") throw new Error(`${target.server.label} issued a ${result.token_type} token, which the overlay cannot use`);

  return { server: target.server, token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
}

const pairedPath = () => join(app.getPath("userData"), "paired-machines.bin");

/** The last list saved or loaded, so a keychain-less session keeps its pairings until it quits. */
let known: PairedMachine[] | null = null;

export async function loadPaired(): Promise<PairedMachine[]> {
  if (known !== null) return known;

  if (!existsSync(pairedPath())) return (known = []);

  // As with the session token, a corrupt file or one sealed by another keychain holds no pairings.
  try {
    // SAFETY: savePaired writes this shape, sealed with safeStorage.
    known = JSON.parse((await safeStorage.decryptStringAsync(await readFile(pairedPath()))).result) as PairedMachine[];
  } catch {
    known = [];
  }

  return known;
}

/** Without an OS keychain the pairings live only in memory, and the next start asks for them again. */
export async function savePaired(machines: PairedMachine[]) {
  known = machines;

  if (!safeStorage.isEncryptionAvailable()) return;

  try {
    await writeFile(pairedPath(), await safeStorage.encryptStringAsync(JSON.stringify(machines)));
  } catch (error) {
    console.warn("[pairing] keeping the paired machines in memory only", error);
  }
}
