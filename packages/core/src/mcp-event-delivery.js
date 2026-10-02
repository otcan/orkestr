// Delivers MCP Events webhooks. Each subscription replays the thread-bridge
// change journal from its own cursor, re-checking the grant on every run
// (readBridgeChanges), so revoking access stops delivery immediately. The
// cursor only advances after a 2xx (or a deliberate skip), so delivery is
// at-least-once; the deterministic eventId lets the receiver deduplicate.
import crypto from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { bridgeMessageVisible } from "../../storage/src/thread-bridge-journal.js";
import { bridgeAgentSources, listBridgeThreads, messageActor, readBridgeChanges } from "./thread-bridge.js";
import { canonicalThreadLink } from "./canonical-app-links.js";
import { getThread, getThreadMessage } from "./threads.js";
import { mutateSubscriptions, readSubscriptions, THREAD_MESSAGE_EVENT, webhookHeaders } from "./mcp-events.js";
import { safePublicFetch } from "./safe-public-fetch.js";
import { safeErrorDiagnostics } from "./safe-error-diagnostics.js";

const TEXT_LIMIT = 8000;
const MAX_BODY_BYTES = 262_144;
const MAX_ATTEMPTS = 10;
const PAGES_PER_RUN = 3;

function clean(value) {
  return String(value ?? "").trim();
}

export function mcpEventDeliveryIntervalMs(env = process.env) {
  const value = Number(env.ORKESTR_MCP_EVENTS_INTERVAL_MS || 5000);
  return Number.isFinite(value) && value >= 500 ? value : 5000;
}

function principalFor(subscription) {
  return {
    kind: "delegated-agent", ownerUserId: subscription.ownerUserId, agentId: subscription.agentId,
    grantId: subscription.grantId, issuer: subscription.issuer, authMethod: subscription.authMethod,
  };
}

function backoffMs(attempts) {
  return Math.min(10 * 60 * 1000, 5000 * 2 ** Math.max(0, attempts - 1));
}

export async function eventPayloadFor(subscription, event, env = process.env) {
  if (event.type !== "message.created") return null;
  if (subscription.arguments?.thread_id && subscription.arguments.thread_id !== event.threadId) return null;
  const message = await getThreadMessage(event.threadId, event.messageId, env).catch(() => null);
  if (!bridgeMessageVisible(message) || bridgeAgentSources.has(message.source)) return null;
  const actor = messageActor(message).kind;
  if (!(subscription.arguments?.actors || ["assistant", "human"]).includes(actor)) return null;
  const thread = await getThread(event.threadId, env).catch(() => null);
  const text = String(message.text || "");
  const url = thread ? await canonicalThreadLink(thread, env).catch(() => "") : "";
  return {
    thread_id: event.threadId,
    thread_name: String(thread?.bindingName || thread?.name || event.threadId),
    message_id: message.id,
    actor,
    text: text.slice(0, TEXT_LIMIT),
    ...(text.length > TEXT_LIMIT ? { truncated: true } : {}),
    created_at: String(message.createdAt || ""),
    ...(url ? { url } : {}),
  };
}

async function post(subscription, payload, cursor, fetchImpl) {
  const eventId = `evt_${crypto.createHash("sha256").update(`${subscription.id}:${payload.message_id}`).digest("hex").slice(0, 24)}`;
  const body = JSON.stringify({ eventId, name: THREAD_MESSAGE_EVENT, timestamp: new Date().toISOString(), data: payload, cursor });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { status: 413 };
  try {
    return await fetchImpl(subscription.url, { method: "POST", body, headers: webhookHeaders({ secret: subscription.secret, id: eventId, body, subscriptionId: subscription.id }) });
  } catch (error) {
    const { errorClass, errorCode } = safeErrorDiagnostics(error);
    return { status: 0, error: errorCode || errorClass };
  }
}

// Processes one subscription; returns a patch, or { remove: reason }.
export async function deliverSubscription(subscription, { env = process.env, fetchImpl = safePublicFetch, now = Date.now() } = {}) {
  if (subscription.nextAttemptAt && Date.parse(subscription.nextAttemptAt) > now) return null;
  const principal = principalFor(subscription);
  let cursor = subscription.cursor || "";
  let delivered = 0;
  for (let pageIndex = 0; pageIndex < PAGES_PER_RUN; pageIndex += 1) {
    let page;
    try {
      page = await readBridgeChanges(principal, { cursor, limit: 50 }, env);
    } catch (error) {
      const code = clean(error?.message);
      if (code === "bridge_cursor_reset_required") {
        const { checkpoint } = await listBridgeThreads(principal, env);
        await appendEvent({ type: "mcp_event_cursor_reset", subscriptionId: subscription.id, agentId: subscription.agentId }, env);
        return { cursor: checkpoint, attempts: 0, nextAttemptAt: null };
      }
      if (["bridge_grant_revoked", "bridge_owner_inactive", "bridge_authentication_required", "thread_bridge_disabled"].includes(code)) return { remove: code };
      throw error;
    }
    for (const event of page.events) {
      const payload = await eventPayloadFor(subscription, event, env);
      if (payload) {
        const response = await post(subscription, payload, event.cursor, fetchImpl);
        if (response.status === 410) return { remove: "receiver_gone" };
        if (response.status === 413) {
          await appendEvent({ type: "mcp_event_skipped", subscriptionId: subscription.id, messageId: event.messageId, reason: "too_large" }, env);
        } else if (!(response.status >= 200 && response.status < 300)) {
          const attempts = Number(subscription.attempts || 0) + 1;
          if (attempts < MAX_ATTEMPTS) {
            return { cursor, attempts, nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString(), lastError: response.error || `HTTP ${response.status}`, delivered };
          }
          await appendEvent({ type: "mcp_event_skipped", subscriptionId: subscription.id, messageId: event.messageId, reason: "retries_exhausted" }, env);
        } else {
          delivered += 1;
        }
        subscription = { ...subscription, attempts: 0 };
      }
      cursor = event.cursor;
    }
    cursor = page.cursor || cursor;
    if (!page.hasMore) break;
  }
  if (cursor === subscription.cursor && !subscription.attempts) return delivered ? { delivered } : null;
  return { cursor, attempts: 0, nextAttemptAt: null, lastError: null, delivered, ...(delivered ? { lastDeliveredAt: new Date(now).toISOString() } : {}) };
}

let running = null;

export function runMcpEventDelivery(env = process.env, options = {}) {
  if (running) return running;
  running = (async () => {
    const { subscriptions } = await readSubscriptions(env);
    const live = subscriptions.filter((entry) => !entry.refreshBefore || Date.parse(entry.refreshBefore) > Date.now());
    if (!live.length) return { subscriptions: 0, delivered: 0 };
    const patches = new Map();
    let delivered = 0;
    for (const subscription of live) {
      try {
        const patch = await (options.deliverFn || deliverSubscription)(subscription, { env, ...options });
        if (patch) patches.set(subscription.id, patch);
        delivered += Number(patch?.delivered || 0);
      } catch (error) {
        await appendEvent({ type: "mcp_event_delivery_failed", subscriptionId: subscription.id, ...safeErrorDiagnostics(error) }, env).catch(() => {});
      }
    }
    if (patches.size) {
      await mutateSubscriptions(env, (state) => {
        state.subscriptions = state.subscriptions.flatMap((entry) => {
          const patch = patches.get(entry.id);
          if (!patch) return [entry];
          if (patch.remove) return [];
          const { delivered: _count, ...rest } = patch;
          return [{ ...entry, ...rest }];
        });
      });
      for (const [id, patch] of patches) {
        if (patch.remove) await appendEvent({ type: "mcp_event_subscription_removed", subscriptionId: id, reason: patch.remove }, env);
      }
    }
    return { subscriptions: live.length, delivered };
  })().finally(() => { running = null; });
  return running;
}
