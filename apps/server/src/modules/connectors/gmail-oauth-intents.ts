import { consumeConnectorUseIntent, createConnectorUseIntent } from "../../../../../packages/core/src/connector-use-intent.js";
import { consumeDurableRateLimit, positiveIntegerEnv } from "../../../../../packages/core/src/durable-rate-limit.js";
import { appendEvent } from "../../../../../packages/storage/src/store.js";
import {
  authenticatedPrincipal,
  originPolicyViolation,
  requestIntentHost,
  requestSessionId,
} from "../../request-security.js";

// Gmail OAuth start intents (ORK-512). Every HTTP alias that can write OAuth
// state first mints a one-time intent for an authenticated principal and then
// consumes it; the OAuth parameters come from the consumed intent only.

export const gmailOAuthStartParamKeys = [
  "account",
  "accountId",
  "alias",
  "useMode",
  "oauthApp",
  "setAsMain",
  "setAsThreadDefault",
  "threadId",
  "returnTarget",
] as const;

const booleanKeys = new Set(["setAsMain", "setAsThreadDefault"]);

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode, code: message });
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function truthy(value: unknown): boolean {
  return value === true || ["1", "true", "yes"].includes(clean(value).toLowerCase());
}

/** Start parameters present in a request body, normalized for binding. */
export function gmailOAuthStartParams(body: Record<string, unknown> = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of gmailOAuthStartParamKeys) {
    if (!Object.hasOwn(body || {}, key)) continue;
    const value = (body as any)[key];
    if (booleanKeys.has(key)) params[key] = truthy(value);
    else params[key] = key === "account" ? clean(value).toLowerCase() : clean(value);
  }
  return params;
}

function withDefaults(params: Record<string, unknown>): Record<string, unknown> {
  const complete: Record<string, unknown> = {};
  for (const key of gmailOAuthStartParamKeys) {
    complete[key] = Object.hasOwn(params, key) ? params[key] : booleanKeys.has(key) ? false : "";
  }
  return complete;
}

export interface GmailOAuthIntentOptions {
  purpose: string;
  subjectUserId?: string;
  capabilities?: string[];
}

async function requireStartCaller(request: any, env: NodeJS.ProcessEnv, purpose: string) {
  const principal = authenticatedPrincipal(request);
  if (!principal) {
    await appendEvent({ type: "gmail_oauth_start_rejected", reason: "authentication_required", purpose }, env).catch(() => {});
    throw httpError("authentication_required", 401);
  }
  const violation = originPolicyViolation(request, env);
  if (violation) {
    await appendEvent({ type: "gmail_oauth_start_rejected", reason: violation, purpose, userId: principal.userId }, env).catch(() => {});
    throw httpError(violation, 403);
  }
  return principal;
}

/** Mint a one-time Gmail OAuth start intent bound to the caller and parameters. */
export async function createGmailOAuthIntent(request: any, body: Record<string, unknown> = {}, env = process.env, options: GmailOAuthIntentOptions) {
  const principal = await requireStartCaller(request, env, options.purpose);
  const params = withDefaults(gmailOAuthStartParams(body));
  if (options.capabilities) params.capabilities = [...options.capabilities];
  return createConnectorUseIntent(clean(principal.userId), {
    connector: "gmail",
    purpose: options.purpose,
    host: requestIntentHost(request, env),
    sessionId: requestSessionId(request),
    subjectUserId: clean(options.subjectUserId),
    params,
  }, env);
}

/**
 * Consume the intent named in `body` and return the bound start parameters.
 * Throws before any OAuth state is written when the caller, host, session,
 * subject, or any supplied parameter differs from the intent.
 */
export async function consumeGmailOAuthIntent(request: any, body: Record<string, unknown> = {}, env = process.env, options: GmailOAuthIntentOptions) {
  const principal = await requireStartCaller(request, env, options.purpose);
  const limit = await consumeDurableRateLimit({
    bucket: "gmail-oauth-start",
    key: clean(principal.userId),
    limit: positiveIntegerEnv(env.ORKESTR_GMAIL_OAUTH_START_RATE_LIMIT, 10),
    windowMs: positiveIntegerEnv(env.ORKESTR_GMAIL_OAUTH_START_RATE_WINDOW_MS, 10 * 60 * 1000, 1_000),
  }, env);
  if (!limit.ok) {
    await appendEvent({ type: "gmail_oauth_start_rejected", reason: "rate_limited", purpose: options.purpose, userId: principal.userId }, env).catch(() => {});
    throw httpError("gmail_oauth_start_rate_limited", 429);
  }
  const supplied: Record<string, unknown> = gmailOAuthStartParams(body);
  if (options.capabilities) supplied.capabilities = [...options.capabilities];
  try {
    const record = await consumeConnectorUseIntent(clean(body.intentId), clean(body.token), {
      userId: clean(principal.userId),
      connector: "gmail",
      purpose: options.purpose,
      host: requestIntentHost(request, env),
      sessionId: requestSessionId(request),
      subjectUserId: clean(options.subjectUserId),
      params: supplied,
    }, env);
    return { principal, params: record.params || {} };
  } catch (error: any) {
    throw httpError(clean(error?.code || error?.message) || "connector_use_intent_invalid", Number(error?.statusCode || 403) || 403);
  }
}

export function boundBoolean(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

export function boundString(params: Record<string, unknown>, key: string): string {
  return clean(params[key]);
}
