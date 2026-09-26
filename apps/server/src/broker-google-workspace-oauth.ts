import { randomUUID } from "node:crypto";
import { startGmailOAuth } from "../../../packages/connectors/src/gmail.js";
import { googleWorkspaceDefaultGmailCapabilities } from "../../../packages/connectors/src/google-workspace-scopes.js";
import { consumeConnectorUseIntent, createConnectorUseIntent } from "../../../packages/core/src/connector-use-intent.js";
import { consumeDurableRateLimit, positiveIntegerEnv } from "../../../packages/core/src/durable-rate-limit.js";
import { appendEvent } from "../../../packages/storage/src/store.js";
import { jsonRequest, originPolicyViolation, requestIntentHost } from "./request-security.js";

// Brokered Google Workspace connect for tenant instances (ORK-512).
//
// A parent-issued auth-intent session (approved pairing challenge scoped to
// `orkestr_auth.google.connect` for one instance) may start Gmail OAuth for the
// instance owner. The tenant UI does so in two POSTs through the parent:
// /api/connectors/gmail/oauth/intent mints a one-time intent bound to the
// owner, session, instance, host and start parameters; /oauth/start consumes
// it. GET starts are refused so a cross-site navigation cannot write state.

export const brokerOAuthIntentPurpose = "broker_oauth_start";
const maxBodyBytes = 16 * 1024;

type Route = { instanceId: string; upstreamPath: string };
type Owner = { userId: string; tenantVmId: string };
type Send = (response: any, statusCode: number, body: Record<string, unknown>) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function truthy(value: unknown): boolean {
  return value === true || ["1", "true", "yes"].includes(clean(value).toLowerCase());
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : clean(value).split(/[\s,]+/g);
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function brokerGoogleWorkspaceOAuthPath(route: Route): "intent" | "start" | "" {
  const pathname = new URL(route.upstreamPath || "/", "http://tenant.local").pathname;
  if (pathname === "/api/connectors/gmail/oauth/intent") return "intent";
  if (pathname === "/api/connectors/gmail/oauth/start") return "start";
  return "";
}

async function readJsonBody(request: any): Promise<Record<string, unknown>> {
  if (request?.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  if (!jsonRequest(request)) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("request_body_too_large"), { statusCode: 413 });
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw Object.assign(new Error("invalid_json_body"), { statusCode: 400 });
  }
}

// Only these request fields may shape the start; everything else (thread,
// chat, WhatsApp account, connect id) comes from the approved auth intent.
function requestParams(body: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const pick = (key: string, ...names: string[]) => {
    const name = names.find((item) => Object.hasOwn(body, item));
    if (name) params[key] = body[name];
  };
  pick("account", "account", "email");
  pick("googleConnectionId", "accountId", "account_id", "googleConnectionId");
  pick("oauthAppId", "oauthApp", "oauth_app", "oauthAppId");
  pick("alias", "alias");
  pick("useMode", "useMode", "use_mode");
  pick("setAsMain", "setAsMain", "set_as_main");
  pick("setAsThreadDefault", "setAsThreadDefault", "set_as_thread_default");
  pick("capabilities", "capabilities", "capability");
  if (Object.hasOwn(params, "account")) params.account = clean(params.account).toLowerCase();
  for (const key of ["googleConnectionId", "oauthAppId", "alias", "useMode"]) {
    if (Object.hasOwn(params, key)) params[key] = clean(params[key]);
  }
  for (const key of ["setAsMain", "setAsThreadDefault"]) {
    if (Object.hasOwn(params, key)) params[key] = truthy(params[key]);
  }
  if (Object.hasOwn(params, "capabilities")) params.capabilities = stringList(params.capabilities);
  return params;
}

function boundParams(intent: Record<string, any>, body: Record<string, unknown>): Record<string, unknown> {
  const supplied = requestParams(body);
  const capabilities = stringList(supplied.capabilities);
  return {
    account: clean(supplied.account ?? "").toLowerCase(),
    googleConnectionId: clean(supplied.googleConnectionId ?? intent.googleConnectionId),
    oauthAppId: clean(supplied.oauthAppId ?? intent.oauthAppId),
    alias: clean(supplied.alias ?? intent.connectionAlias),
    useMode: clean(supplied.useMode ?? intent.connectionUseMode),
    setAsMain: Object.hasOwn(supplied, "setAsMain") ? supplied.setAsMain === true : truthy(intent.setAsMain),
    setAsThreadDefault: Object.hasOwn(supplied, "setAsThreadDefault") ? supplied.setAsThreadDefault === true : truthy(intent.setAsThreadDefault),
    capabilities: capabilities.length ? capabilities : googleWorkspaceDefaultGmailCapabilities(),
  };
}

async function reject(response: any, send: Send, statusCode: number, error: string, route: Route, env = process.env) {
  await appendEvent({ type: "gmail_oauth_start_rejected", reason: error, purpose: brokerOAuthIntentPurpose, instanceId: route.instanceId }, env).catch(() => {});
  send(response, statusCode, { ok: false, error });
}

/** Handles the brokered intent/start pair for an auth-intent session. */
export async function handleBrokerGoogleWorkspaceOAuth(request: any, response: any, route: Route, owner: Owner, send: Send, env = process.env): Promise<void> {
  const kind = brokerGoogleWorkspaceOAuthPath(route);
  const method = clean(request?.method || "GET").toUpperCase();
  if (method !== "POST") return reject(response, send, 405, "oauth_start_requires_post", route, env);
  const violation = originPolicyViolation(request, env);
  if (violation) return reject(response, send, 403, violation, route, env);
  const session = request?.orkestrSecuritySession || {};
  const intent = session.authIntent && typeof session.authIntent === "object" ? session.authIntent : {};
  const userId = clean(owner.userId || intent.userId || session.userId);
  if (!userId) return reject(response, send, 403, "broker_instance_owner_required", route, env);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error: any) {
    return reject(response, send, Number(error?.statusCode || 400), clean(error?.message) || "invalid_json_body", route, env);
  }
  const binding = {
    userId,
    connector: "gmail",
    purpose: brokerOAuthIntentPurpose,
    host: requestIntentHost(request, env),
    sessionId: clean(session.id),
    instanceId: route.instanceId,
  };
  if (kind === "intent") {
    try {
      const created = await createConnectorUseIntent(userId, { ...binding, params: boundParams(intent, body) }, env);
      send(response, 201, { ok: true, ...created });
    } catch (error: any) {
      await reject(response, send, Number(error?.statusCode || 400) || 400, clean(error?.code || error?.message), route, env);
    }
    return;
  }
  const limit = await consumeDurableRateLimit({
    bucket: "gmail-oauth-start",
    key: userId,
    limit: positiveIntegerEnv(env.ORKESTR_GMAIL_OAUTH_START_RATE_LIMIT, 10),
    windowMs: positiveIntegerEnv(env.ORKESTR_GMAIL_OAUTH_START_RATE_WINDOW_MS, 10 * 60 * 1000, 1_000),
  }, env);
  if (!limit.ok) return reject(response, send, 429, "gmail_oauth_start_rate_limited", route, env);
  let params: Record<string, any>;
  try {
    const record = await consumeConnectorUseIntent(clean(body.intentId), clean(body.token), { ...binding, params: requestParams(body) }, env);
    params = record.params || {};
  } catch (error: any) {
    return reject(response, send, Number(error?.statusCode || 403) || 403, clean(error?.code || error?.message) || "connector_use_intent_invalid", route, env);
  }
  const connectId = clean(intent.connectId || session.challengeId || session.id) || randomUUID();
  const threadId = clean(intent.threadId);
  const chatId = clean(intent.chatId);
  const accountId = clean(intent.accountId);
  try {
    const started = await startGmailOAuth(env, {
      userId,
      initiatorUserId: clean(session.userId) || userId,
      provider: "google_workspace",
      capabilities: params.capabilities,
      account: clean(params.account),
      googleConnectionId: clean(params.googleConnectionId),
      oauthAppId: clean(params.oauthAppId),
      alias: clean(params.alias),
      useMode: clean(params.useMode),
      setAsMain: params.setAsMain === true,
      setAsThreadDefault: params.setAsThreadDefault === true,
      ignoreConfiguredAccount: true,
      connectId,
      threadId,
      chatId,
      accountId,
      brokerInstanceId: route.instanceId,
      brokerTenantVmId: clean(intent.tenantVmId || owner.tenantVmId),
      brokerTenantUserId: userId,
      brokerTenantThreadId: threadId,
      brokerTenantChatId: chatId,
      brokerTenantAccountId: accountId,
    });
    send(response, 200, { ...started, ok: true, provider: "google_workspace", connectId });
  } catch (error: any) {
    send(response, Number(error?.statusCode || 400) || 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
