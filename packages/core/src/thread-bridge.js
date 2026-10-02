import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendThreadBridgeReply, threadBridgeChanges, threadMessageStoreEnabled } from "../../storage/src/thread-message-registry.js";
import { bridgeMessageVisible } from "../../storage/src/thread-bridge-journal.js";
import { getThread, listThreads, listThreadMessages, isThreadRetired } from "./threads.js";
import { getUser } from "./users.js";
import { resourceOwnerUserId } from "./policy.js";
import { withThreadMessageMutation } from "./thread-message-mutation.js";

const fail = (code, statusCode = 403) => { throw Object.assign(new Error(code), { statusCode }); };
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
const inScope = (scope, id) => scope === "all" || (Array.isArray(scope) && scope.includes(id));

// This is an internal trust boundary: principal MUST come from an authentication
// adapter, never JSON input, headers copied verbatim, or the admin fallback.
export async function authorization(principal, env) {
  if (env.ORKESTR_THREAD_BRIDGE_ENABLED !== "1") fail("thread_bridge_disabled", 404);
  if (principal?.kind !== "delegated-agent" || !identifier(principal.ownerUserId) ||
      !identifier(principal.agentId) || !identifier(principal.grantId) ||
      typeof principal.issuer !== "string" || !principal.issuer || principal.issuer.length > 256 || !identifier(principal.authMethod)) fail("bridge_authentication_required", 401);
  const owner = await getUser(principal.ownerUserId, env);
  if (!owner || owner.status !== "active") fail("bridge_owner_inactive");
  if (!await threadMessageStoreEnabled(env)) fail("bridge_requires_sqlite", 503);
  const file = path.join(dataPaths(env).home, "thread-bridge-grants.json");
  // No defaults, automatic grants, or principal-supplied scopes. Operators own
  // this security-sensitive file; a missing/invalid file fails closed.
  const config = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
  const matches = Array.isArray(config) ? config.filter(grant => grant && typeof grant === "object" && grant.id === principal.grantId) : [];
  const grant = matches.length === 1 ? matches[0] : null;
  if (!grant || grant.enabled !== true || grant.ownerUserId !== principal.ownerUserId || grant.agentId !== principal.agentId || grant.issuer !== principal.issuer || grant.authMethod !== principal.authMethod ||
      !grant.expiresAt || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) fail("bridge_grant_revoked");
  return grant;
}

function allowed(thread, grant, scope, env) {
  const granted = scope === "reply" ? grant.reply : scope === "message" ? grant.message : grant.observe;
  return thread && !thread.deletedAt && !isThreadRetired(thread) && resourceOwnerUserId(thread, env) === grant.ownerUserId && inScope(granted, thread.id);
}

export async function target(threadId, grant, scope, env) {
  if (!identifier(threadId)) fail("bridge_thread_not_found", 404);
  const thread = await getThread(threadId, env);
  // IDs only: aliases must never resolve to another account's same-named thread.
  if (!thread || thread.id !== threadId || !allowed(thread, grant, scope, env)) fail("bridge_thread_not_found", 404);
  return thread;
}

export async function listBridgeThreads(principal, env = process.env) {
  const grant = await authorization(principal, env);
  const { currentCursor: checkpoint } = await threadBridgeChanges(grant.ownerUserId, { limit: 1 }, env);
  const currentGrant = await authorization(principal, env);
  const threads = (await listThreads(env)).filter(thread => allowed(thread, currentGrant, "observe", env));
  return { threadIds: threads.map(thread => thread.id), checkpoint };
}

export async function readBridgeChanges(principal, options = {}, env = process.env) {
  const grant = await authorization(principal, env);
  const page = await threadBridgeChanges(grant.ownerUserId, options, env);
  // Re-evaluate the grant and current ownership on every page. A feed does not
  // confer historical access, and revoked/archived resources are not returned.
  const currentGrant = await authorization(principal, env);
  const threadIds = (await listThreads(env)).filter(thread => allowed(thread, currentGrant, "observe", env)).map(thread => thread.id);
  const permitted = new Set(threadIds);
  const events = page.events.filter(event => permitted.has(event.threadId) && event.originAgentId !== principal.agentId);
  return { ...page, events, lastDeliveredCursor: events.at(-1)?.cursor || null, threadIds };
}

// Only messages a person typed are "human". Timers, workers, watches, mailbox
// routing, CLI sends and other machine inputs are role "user" in the
// transcript but must never read as the owner's own instructions.
// Comments (thread_bridge_agent) and messages (thread_bridge_message) written
// by a connected assistant.
export const bridgeAgentSources = new Set(["thread_bridge_agent", "thread_bridge_message"]);
const humanInputSources = new Set(["whatsapp_inbound", "whatsapp", "ui", "webui", "web", "manual", "mobile", "telegram_inbound"]);

export function messageActor(message = {}) {
  const source = String(message.source || "").trim().toLowerCase();
  if (bridgeAgentSources.has(source)) return { kind: "delegated-agent", agentId: String(message.bridgeAgentId || "") };
  if (message.role === "assistant") return { kind: "assistant" };
  if (humanInputSources.has(source)) return { kind: "human" };
  return { kind: "automation", source: source || "unknown" };
}

function projectMessage(message) {
  return {
    id: message.id,
    role: message.role,
    text: String(message.text || ""),
    createdAt: String(message.createdAt || ""),
    actor: messageActor(message),
    contextOnly: true,
  };
}

export async function readBridgeHistory(threadId, principal, { after = "", limit = 100, latest = false } = {}, env = process.env) {
  const grant = await authorization(principal, env);
  await target(threadId, grant, "observe", env);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("bridge_limit_invalid", 400);
  const messages = (await listThreadMessages(threadId, env)).filter(bridgeMessageVisible);
  // `latest` returns the newest page; continue forward from its last id.
  const offset = latest && !after ? Math.max(0, messages.length - limit) : after ? messages.findIndex(message => message.id === after) + 1 : 0;
  if (after && !offset) fail("bridge_history_reset_required", 409);
  const selected = messages.slice(offset, offset + limit);
  await target(threadId, await authorization(principal, env), "observe", env);
  return { threadId, messages: selected.map(projectMessage), after: selected.at(-1)?.id || after, hasMore: offset + selected.length < messages.length };
}

export async function replyToBridgeThread(threadId, input, principal, env = process.env) {
  const grant = await authorization(principal, env);
  await target(threadId, grant, "reply", env);
  if (!input || Object.keys(input).some(key => !["requestId", "text", "causedByMessageId"].includes(key)) ||
      !identifier(input.requestId) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000 ||
      (input.causedByMessageId !== undefined && !identifier(input.causedByMessageId))) fail("bridge_reply_invalid", 400);
  const text = input.text.trim();
  const cause = input.causedByMessageId || null;
  const requestHash = createHash("sha256").update(JSON.stringify({ text, causedByMessageId: cause })).digest("hex");
  return withThreadMessageMutation(threadId, env, async () => {
    const currentGrant = await authorization(principal, env);
    await target(threadId, currentGrant, "reply", env);
    if (cause) {
      await target(threadId, currentGrant, "observe", env);
      const source = (await listThreadMessages(threadId, env)).find(message => message.id === cause);
      if (!bridgeMessageVisible(source) || source.source === "thread_bridge_agent") fail("bridge_cause_invalid", 409);
    }
    // Persist a comment only. It cannot steer, wake, approve, schedule, invoke
    // a connector, reserve a human mailbox context, or run a tool.
    return appendThreadBridgeReply(threadId, {
      id: randomUUID(), ownerUserId: currentGrant.ownerUserId, role: "assistant",
      source: "thread_bridge_agent", phase: "delegated_comment", state: "completed", text,
      createdAt: new Date().toISOString(), bridgeAgentId: principal.agentId,
      bridgeGrantId: principal.grantId, parentMessageId: cause, contextOnly: true,
    }, { ownerId: currentGrant.ownerUserId, agentId: principal.agentId, grantId: principal.grantId, requestId: input.requestId, requestHash }, env);
  });
}
