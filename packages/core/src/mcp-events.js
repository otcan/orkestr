// MCP Events (draft extension used by ChatGPT, protocol 2026-07-28):
// events/list, events/subscribe and events/unsubscribe for thread messages,
// with Standard Webhooks signing and the callback verification handshake.
// Delivery itself runs in mcp-event-delivery.js. Subscriptions persist under
// secrets/ because they hold the webhook signing secret.
import crypto from "node:crypto";
import path from "node:path";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { dataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { listBridgeThreads } from "./thread-bridge.js";
import { safePublicFetch, assertPublicHttpsUrl } from "./safe-public-fetch.js";

export const THREAD_MESSAGE_EVENT = "thread.message.created";
const ACTORS = ["human", "assistant", "automation"];
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFICATION_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS_PER_AGENT = 20;

function clean(value) {
  return String(value ?? "").trim();
}

// JSON-RPC level error; `code` -32602 = invalid params.
export function eventError(message, code = -32602) {
  return Object.assign(new Error(message), { rpcCode: code });
}

export const eventDefinitions = Object.freeze([{
  name: THREAD_MESSAGE_EVENT,
  description: "A new visible message appeared in one of your Orkestr threads (or in one specific thread). By default only messages typed by the owner (human) and agent answers (assistant) are sent; add \"automation\" to also get timer, worker and routing input. Your own comments are never echoed back.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "Only this thread. Omit to watch all your threads, including future ones." },
      actors: { type: "array", items: { type: "string", enum: ACTORS }, description: "Which authors to deliver. Default: [\"human\", \"assistant\"]." },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string" },
      thread_name: { type: "string" },
      message_id: { type: "string" },
      actor: { type: "string", enum: ACTORS },
      text: { type: "string" },
      truncated: { type: "boolean" },
      created_at: { type: "string" },
      url: { type: "string" },
    },
    required: ["thread_id", "thread_name", "message_id", "actor", "text", "created_at"],
    additionalProperties: false,
  },
}]);

export function normalizeEventArguments(name, args = {}) {
  if (name !== THREAD_MESSAGE_EVENT) throw eventError(`Unknown event: ${clean(name) || "(none)"}`);
  const input = args && typeof args === "object" ? args : {};
  const extra = Object.keys(input).filter((key) => !["thread_id", "actors"].includes(key));
  if (extra.length) throw eventError(`Unknown arguments: ${extra.join(", ")}`);
  const threadId = input.thread_id === undefined || input.thread_id === null ? "" : clean(input.thread_id);
  if (input.thread_id !== undefined && !/^[a-zA-Z0-9_.-]{1,128}$/.test(threadId)) throw eventError("thread_id is invalid");
  const actors = input.actors === undefined ? ["human", "assistant"] : input.actors;
  if (!Array.isArray(actors) || !actors.length || actors.some((actor) => !ACTORS.includes(actor))) throw eventError(`actors must be a non-empty subset of ${ACTORS.join(", ")}`);
  return { ...(threadId ? { thread_id: threadId } : {}), actors: [...new Set(actors)].sort() };
}

export function webhookSecretKey(secret = "") {
  const match = /^whsec_([A-Za-z0-9+/=]+)$/.exec(clean(secret));
  const key = match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
  if (key.length < 24 || key.length > 64) throw eventError("delivery.secret must be whsec_ + base64 of 24-64 bytes");
  return key;
}

// Standard Webhooks: v1,base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")).
export function signWebhook(secret, id, timestamp, body) {
  const signature = crypto.createHmac("sha256", webhookSecretKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${signature}`;
}

export function webhookHeaders({ secret, id, body, subscriptionId = "", now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signWebhook(secret, id, timestamp, body),
    ...(subscriptionId ? { "x-mcp-subscription-id": subscriptionId } : {}),
    "user-agent": "Orkestr-MCP-Events/1",
  };
}

export function subscriptionsPath(env = process.env) {
  return env.ORKESTR_MCP_EVENTS_FILE || path.join(dataPaths(env).secrets, "mcp-event-subscriptions.json");
}

export async function readSubscriptions(env = process.env) {
  const state = await readJson(subscriptionsPath(env), { subscriptions: [], verifications: [] });
  return { subscriptions: state.subscriptions || [], verifications: state.verifications || [] };
}

export async function mutateSubscriptions(env, operation) {
  const file = subscriptionsPath(env);
  return withStorageFileLock(file, async () => {
    const state = await readSubscriptions(env);
    const now = Date.now();
    state.subscriptions = state.subscriptions.filter((entry) => !entry.refreshBefore || Date.parse(entry.refreshBefore) > now);
    state.verifications = state.verifications.filter((entry) => Date.parse(entry.expiresAt) > now);
    const result = await operation(state);
    await writeSecretJson(file, state);
    return result;
  });
}

// Identity = principal + callback URL + event name + arguments (spec).
export function subscriptionId(principal, url, name, args) {
  const key = JSON.stringify([principal.ownerUserId, principal.agentId, principal.grantId, url, name, args]);
  return `sub_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function grantedTtl(ttlMs) {
  if (ttlMs === undefined || ttlMs === null) return DEFAULT_TTL_MS;
  const value = Number(ttlMs);
  if (!Number.isFinite(value) || value <= 0) throw eventError("ttlMs must be a positive number");
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, value));
}

async function verifyCallback({ url, secret }, fetchImpl) {
  const challenge = crypto.randomBytes(24).toString("base64url");
  const body = JSON.stringify({ type: "verification", challenge });
  const id = `msg_verification_${crypto.randomBytes(8).toString("hex")}`;
  let response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: webhookHeaders({ secret, id, body }), body });
  } catch (error) {
    throw eventError(`Callback verification failed: ${clean(error?.message) || "request_failed"}`);
  }
  let echoed = clean(response.text);
  try { echoed = clean(JSON.parse(response.text)?.challenge); } catch { /* plain-text echo */ }
  const ok = response.status >= 200 && response.status < 300 && echoed.length === challenge.length &&
    crypto.timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
  if (!ok) throw eventError(`Callback verification failed (HTTP ${response.status}).`);
}

// params: { name, arguments, delivery: { mode, url, secret }, cursor, ttlMs }
// `checkpoint` resolves the current bridge cursor for new subscriptions.
export async function subscribeEvent(params = {}, principal, { env = process.env, fetchImpl = safePublicFetch, checkpoint = null } = {}) {
  const name = clean(params.name);
  const args = normalizeEventArguments(name, params.arguments);
  const delivery = params.delivery || {};
  if (delivery.mode !== "webhook") throw eventError("Only delivery.mode \"webhook\" is supported.");
  let url;
  try { url = assertPublicHttpsUrl(delivery.url).toString(); } catch (error) { throw eventError(`delivery.url rejected: ${error.message}`); }
  webhookSecretKey(delivery.secret);
  // Fails with the bridge's own error when the grant is gone or the thread is not visible.
  const { threadIds, checkpoint: current } = await listBridgeThreads(principal, env);
  if (args.thread_id && !threadIds.includes(args.thread_id)) throw eventError("thread_id is not one of your threads");
  const id = subscriptionId(principal, url, name, args);
  const ttl = grantedTtl(params.ttlMs);
  const verified = (await readSubscriptions(env)).verifications.some((entry) =>
    entry.agentId === principal.agentId && entry.url === url && Date.parse(entry.expiresAt) > Date.now());
  if (!verified) await verifyCallback({ url, secret: delivery.secret }, fetchImpl);
  const requested = clean(params.cursor);
  const startCursor = requested || (checkpoint ? await checkpoint() : current);
  const refreshBefore = new Date(Date.now() + ttl).toISOString();
  const subscription = await mutateSubscriptions(env, (state) => {
    if (!verified) state.verifications.push({ agentId: principal.agentId, url, expiresAt: new Date(Date.now() + VERIFICATION_CACHE_MS).toISOString() });
    const existing = state.subscriptions.find((entry) => entry.id === id);
    const others = state.subscriptions.filter((entry) => entry.agentId === principal.agentId && entry.id !== id);
    if (!existing && others.length >= MAX_SUBSCRIPTIONS_PER_AGENT) throw eventError("Too many subscriptions for this client.", -32000);
    const next = {
      ...(existing || { createdAt: new Date().toISOString(), attempts: 0 }),
      id, name, arguments: args, url, secret: delivery.secret,
      ownerUserId: principal.ownerUserId, agentId: principal.agentId, grantId: principal.grantId,
      issuer: principal.issuer, authMethod: principal.authMethod,
      // Refresh keeps the server's own cursor unless the client resumes explicitly.
      cursor: requested || existing?.cursor || startCursor,
      refreshBefore,
    };
    state.subscriptions = [...state.subscriptions.filter((entry) => entry.id !== id), next];
    return next;
  });
  await appendEvent({ type: "mcp_event_subscribed", userId: principal.ownerUserId, agentId: principal.agentId, subscriptionId: id, name, threadId: args.thread_id || null }, env);
  return { id, refreshBefore, cursor: subscription.cursor || null, truncated: false };
}

export async function unsubscribeEvent(params = {}, principal, { env = process.env } = {}) {
  const name = clean(params.name);
  const args = normalizeEventArguments(name, params.arguments);
  let url = "";
  try { url = assertPublicHttpsUrl(params.delivery?.url).toString(); } catch { return {}; }
  const id = subscriptionId(principal, url, name, args);
  await mutateSubscriptions(env, (state) => {
    state.subscriptions = state.subscriptions.filter((entry) => !(entry.id === id && entry.agentId === principal.agentId));
  });
  await appendEvent({ type: "mcp_event_unsubscribed", userId: principal.ownerUserId, agentId: principal.agentId, subscriptionId: id }, env);
  return {};
}
