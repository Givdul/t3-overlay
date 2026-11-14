import { createHash, randomBytes } from "node:crypto";
import type { T3Server } from "./t3";

// The overlay's full-access MCP session, granted through T3's own OAuth flow
// (apps/server/src/auth/McpOAuth.ts). A CLI-minted session carries no runtimeModeCeiling, so T3 caps
// it at approval-required and refuses to act on a full-access thread; the grant is the one way to
// store an access level above that. This is the browser side of that flow without a browser: the
// overlay asks for the approval and posts the decision with its own `/ws` session, then reads the code
// out of the redirect T3 would have followed. Every URL comes from the pid-verified origin, the
// resource is exactly `${origin}/mcp`, and the granted token is used against that URL and no other.

/** The client name T3 registers, and so the label its session list shows the grant under. */
export const GRANT_CLIENT_NAME = "t3-overlay grant";

/** T3 redirects only to https or a loopback address, and never fetches it; the overlay does not either. */
const REDIRECT_URI = "http://127.0.0.1:1/cb";

const REQUEST_TIMEOUT_MS = 15_000;

/** A managed policy's cap, as `/approval` reports it; the grant cannot exceed it. */
export interface RuntimeModeCeiling {
  organization: string;
  maxRuntimeMode: string;
}

export interface GrantConsent {
  runtimeModeCeiling: RuntimeModeCeiling | undefined;
}

export interface Granted {
  token: string;
  /** Epoch milliseconds. T3 issues 30 days, with no refresh. */
  expiresAt: number;
}

interface Authorization {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string;
  resource: string;
}

interface ClientRegistration {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
}

interface DecisionRequest {
  authorization: Authorization;
  decision: { _tag: "browser-session"; access: "full-access"; csrfToken: string };
}

type RequestBody = ClientRegistration | Authorization | DecisionRequest;

/**
 * T3 refuses an OAuth call with one of two error schemas. Every reply below is the endpoint's success
 * branch plus these fields, so a refusal is read from the same parse as the success.
 */
interface OAuthRefusal {
  /** AuthMcpApprovalError's message. */
  message?: string;
  /** AuthMcpRegistrationError's and AuthMcpTokenError's reason. */
  error?: string;
  error_description?: string;
}

interface RegisteredClient extends OAuthRefusal {
  client_id?: string;
}

interface ApprovalReply extends OAuthRefusal {
  csrfToken?: string;
  /** The access levels this session may approve on its own; full access needs to be among them. */
  oneClickAccess?: string[];
  runtimeModeCeiling?: RuntimeModeCeiling;
  redirectTo?: string;
}

interface DecisionReply extends OAuthRefusal {
  redirectTo?: string;
}

interface TokenReply extends OAuthRefusal {
  access_token?: string;
  expires_in?: number;
}

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

/**
 * Grants the overlay full access on every linked machine. `consent` runs after T3 has described the
 * approval and before the decision, so the runtime-mode ceiling it reports is part of the question;
 * a declined consent leaves no session behind.
 */
export async function grantRemoteControl(
  server: T3Server,
  session: string,
  consent: (consent: GrantConsent) => Promise<boolean>,
): Promise<Granted | null> {
  const clientId = await register(server);
  const verifier = base64Url(randomBytes(32));

  const authorization: Authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state: base64Url(randomBytes(16)),
    resource: `${server.origin}/mcp`,
  };

  const approval = await approvalOf(server, session, authorization);

  // A session that cannot approve on its own would have to spend a pairing code instead.
  if (approval.csrfToken === undefined || approval.oneClickAccess?.includes("full-access") !== true) {
    throw new Error("T3 would not approve full access from this session");
  }

  if (!(await consent({ runtimeModeCeiling: approval.runtimeModeCeiling }))) return null;

  const redirect = await decisionOf(server, session, authorization, approval.csrfToken);

  return exchange(server, authorization, verifier, codeOf(redirect, authorization.state, server.origin));
}

async function register(server: T3Server): Promise<string> {
  const { client_id: clientId } = await sendJson<RegisteredClient>(server, "/oauth/mcp/register", {
    client_name: GRANT_CLIENT_NAME,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
  });

  if (clientId === undefined) throw new Error("T3 registered no client");

  return clientId;
}

async function approvalOf(server: T3Server, session: string, authorization: Authorization): Promise<ApprovalReply> {
  const approval = await sendJson<ApprovalReply>(server, "/oauth/mcp/approval", authorization, session);

  // The approval endpoint answers with the request it rejected instead of details.
  if (approval.redirectTo !== undefined) {
    throw new Error(`T3 refused the sign-in: ${refusalOf(approval.redirectTo, server.origin)}`);
  }

  return approval;
}

async function decisionOf(server: T3Server, session: string, authorization: Authorization, csrfToken: string): Promise<string> {
  const { redirectTo } = await sendJson<DecisionReply>(
    server,
    "/oauth/mcp/decision",
    { authorization, decision: { _tag: "browser-session", access: "full-access", csrfToken } },
    session,
  );

  if (redirectTo === undefined) throw new Error("T3 approved the sign-in without a redirect");

  return redirectTo;
}

async function exchange(server: T3Server, authorization: Authorization, verifier: string, code: string): Promise<Granted> {
  // T3 spends the code when it arrives, so a retry could only be refused.
  const { access_token: token, expires_in: expiresIn } = await send<TokenReply>(
    server,
    "/oauth/mcp/token",
    {
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: authorization.redirect_uri,
        client_id: authorization.client_id,
        code_verifier: verifier,
        resource: authorization.resource,
      }).toString(),
    },
    1,
  );

  if (token === undefined || expiresIn === undefined) throw new Error("T3 returned no token");

  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

function sendJson<T extends OAuthRefusal>(server: T3Server, path: string, body: RequestBody, session?: string): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" });

  if (session !== undefined) headers.set("authorization", `Bearer ${session}`);

  // None of these spends anything, so a dropped connection can be retried once.
  return send<T>(server, path, { headers, body: JSON.stringify(body) }, 2);
}

/** One POST to an OAuth endpoint whose only body it accepts is that endpoint's shape. */
async function send<T extends OAuthRefusal>(
  server: T3Server,
  path: string,
  request: { headers: Headers; body: string },
  attempts: number,
): Promise<T> {
  const response = await post(server, path, request, attempts);

  // SAFETY: every OAuth endpoint answers JSON, and the caller names the success branch it expects;
  // the error branch's fields are part of T, so both are read from this one parse.
  const reply = (await response.json()) as T;

  if (!response.ok) throw new Error(`${path}: ${failureOf(reply) ?? `HTTP ${response.status}`}`);

  return reply;
}

/**
 * One attempt, then a retry while `attempts` allows: the app's process already holds long-lived
 * connections to T3 (`/mcp`, the shell's socket), so a pooled one T3 dropped under this request shows
 * up as a reset, and the flow should not fail on it. The endpoints before `/token` are safe to ask
 * twice; `/token` spends the authorization code on arrival, so it is asked once.
 */
async function post(server: T3Server, path: string, request: { headers: Headers; body: string }, attempts: number): Promise<Response> {
  try {
    return await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (attempts > 1) return post(server, path, request, attempts - 1);

    // The dialog's message says which step failed, not only that a connection did.
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The authorization code, read only after the redirect names this origin as its issuer and echoes this
 * request's state: a redirect for another server or another sign-in is not one to spend.
 */
function codeOf(redirect: string, state: string, origin: string): string {
  const url = new URL(redirect);

  if (url.searchParams.get("iss") !== origin) throw new Error("T3's sign-in answered for another server");

  if (url.searchParams.get("state") !== state) throw new Error("T3's sign-in answered for another request");

  // The answer belongs on the callback that was registered, never on an address someone else named.
  if (!redirect.startsWith(`${REDIRECT_URI}?`)) throw new Error("T3's sign-in answered another address");

  const error = url.searchParams.get("error");

  if (error !== null) throw new Error(url.searchParams.get("error_description") ?? error);

  const code = url.searchParams.get("code");

  if (code === null) throw new Error("T3's sign-in returned no code");

  return code;
}

/** T3's reason in an error redirect, once the redirect is known to be this server's. */
function refusalOf(redirect: string, origin: string): string {
  const url = new URL(redirect);

  if (url.searchParams.get("iss") !== origin) return "the answer came from another address";

  return url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "the sign-in was rejected";
}

function failureOf(reply: OAuthRefusal): string | undefined {
  return reply.error_description ?? reply.message ?? reply.error;
}
