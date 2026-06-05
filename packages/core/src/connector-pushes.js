import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { enqueueAgentMessage } from "./messages.js";
import { assertOwnerAccess, canAccessOwner, isAdminPrincipal, policyError } from "./policy.js";
import { principalForUserId, userPrincipal } from "./principal.js";
import { enqueueThreadInput, getThread, getThreadForPrincipal } from "./threads.js";
import { userScopedCapabilityHints } from "./user-skills.js";
import { adminUserId, normalizeUserId } from "./users.js";

const supportedPromptPushConnectors = new Set(["gmail"]);
const maxPromptPushItemsPerRun = 5;
const maxPromptChars = 8000;
const defaultBodyPreviewChars = 1200;
const defaultMinIntervalMs = 0;

function clean(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function optionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function safeObject(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, 50)) {
    const key = clean(rawKey).slice(0, 80);
    if (!key || /(token|secret|password|credential|cookie|session|bearer|api[_-]?key|private[_-]?key)/i.test(key)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      output[key] = rawValue;
    } else if (Array.isArray(rawValue)) {
      output[key] = rawValue.slice(0, 20).map((item) => clean(item).slice(0, 1000));
    } else if (typeof rawValue === "object") {
      output[key] = safeObject(rawValue);
    } else {
      output[key] = clean(rawValue).slice(0, 2000);
    }
  }
  return output;
}

function pushStorePath(env = process.env) {
  return dataPaths(env).connectorPromptPushes;
}

async function readPushStore(env = process.env) {
  const payload = await readJson(pushStorePath(env), { schemaVersion: 1, pushes: [] });
  const pushes = Array.isArray(payload?.pushes) ? payload.pushes : Array.isArray(payload) ? payload : [];
  return {
    schemaVersion: 1,
    pushes,
  };
}

async function writePushStore(store, env = process.env) {
  return writeJson(pushStorePath(env), {
    schemaVersion: 1,
    pushes: Array.isArray(store?.pushes) ? store.pushes : [],
    updatedAt: nowIso(),
  });
}

function promptPushError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function connectorPromptPushSafety(input = {}) {
  const source = input.safety && typeof input.safety === "object" ? input.safety : input;
  const maxItems = Math.floor(optionalNumber(source.maxItemsPerRun ?? source.maxResults, 1) || 1);
  const bodyPreviewChars = Math.floor(optionalNumber(source.bodyPreviewChars, defaultBodyPreviewChars) || defaultBodyPreviewChars);
  const minIntervalMs = Math.floor(optionalNumber(source.minIntervalMs, defaultMinIntervalMs) || defaultMinIntervalMs);
  return {
    maxItemsPerRun: Math.max(1, Math.min(maxPromptPushItemsPerRun, maxItems)),
    minIntervalMs: Math.max(0, minIntervalMs),
    bodyPreviewChars: Math.max(0, Math.min(6000, bodyPreviewChars)),
    requireQuery: boolValue(source.requireQuery, true),
    allowBroadQuery: boolValue(source.allowBroadQuery, false),
    noReplyBehavior: clean(source.noReplyBehavior),
  };
}

export function normalizeConnectorPromptPush(input = {}, env = process.env) {
  const connector = cleanLower(input.connector || input.source || input.provider);
  const sourceConfig = safeObject(input.sourceConfig || input.config || {});
  const safety = connectorPromptPushSafety({ ...sourceConfig, ...(input.safety || {}), ...(input.limits || {}) });
  const now = nowIso();
  const prompt = clean(input.prompt || input.instruction || input.promptTemplate);
  const promptTemplate = clean(input.promptTemplate || input.template || "");
  const targetType = cleanLower(input.targetType || (input.threadId ? "thread" : "agent")) || "thread";
  return {
    id: clean(input.id || input.pushId) || randomUUID(),
    ownerUserId: normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
    connector,
    source: connector,
    label: clean(input.label || `${connector || "connector"} prompt push`),
    targetType,
    target: clean(input.target || input.threadId || input.agentId),
    prompt,
    promptTemplate,
    sourceConfig,
    safety,
    automationType: cleanLower(input.automationType || input.notificationType || input.kind),
    schedule: safeObject(input.schedule || {}),
    nextRunAt: clean(input.nextRunAt || input.schedule?.nextRunAt),
    enabled: input.enabled === true,
    createdAt: clean(input.createdAt) || now,
    updatedAt: clean(input.updatedAt) || now,
    lastRunAt: clean(input.lastRunAt),
    lastDeliveredAt: clean(input.lastDeliveredAt),
    lastError: clean(input.lastError).slice(0, 500),
    lastErrorAt: clean(input.lastErrorAt),
    failureCount: Math.max(0, Math.floor(optionalNumber(input.failureCount, 0) || 0)),
    deliveredCount: Math.max(0, Math.floor(optionalNumber(input.deliveredCount, 0) || 0)),
    processedSourceItemIds: Array.isArray(input.processedSourceItemIds)
      ? [...new Set(input.processedSourceItemIds.map(clean).filter(Boolean))].slice(-500)
      : [],
  };
}

export function validateConnectorPromptPush(push = {}) {
  if (!supportedPromptPushConnectors.has(push.connector)) throw promptPushError("connector_prompt_push_connector_unsupported");
  if (!push.target) throw promptPushError("connector_prompt_push_target_required");
  if (!["thread", "agent"].includes(push.targetType)) throw promptPushError("connector_prompt_push_target_type_invalid");
  if (!push.prompt && !push.promptTemplate) throw promptPushError("connector_prompt_push_prompt_required");
  if (
    push.connector === "gmail" &&
    push.safety?.requireQuery !== false &&
    push.safety?.allowBroadQuery !== true &&
    !clean(push.sourceConfig?.query)
  ) {
    throw promptPushError("connector_prompt_push_query_required");
  }
  return true;
}

export async function listConnectorPromptPushes(env = process.env) {
  const store = await readPushStore(env);
  return store.pushes.map((push) => normalizeConnectorPromptPush(push, env));
}

export async function getConnectorPromptPush(id, env = process.env) {
  const pushId = clean(id);
  return (await listConnectorPromptPushes(env)).find((push) => push.id === pushId) || null;
}

export async function listConnectorPromptPushesForPrincipal(principal, env = process.env) {
  const pushes = await listConnectorPromptPushes(env);
  if (isAdminPrincipal(principal)) return pushes;
  return pushes.filter((push) => canAccessOwner(principal, push.ownerUserId, env));
}

export async function createConnectorPromptPush(input = {}, env = process.env) {
  const store = await readPushStore(env);
  const push = normalizeConnectorPromptPush(input, env);
  validateConnectorPromptPush(push);
  if (store.pushes.some((entry) => clean(entry.id) === push.id)) throw promptPushError("connector_prompt_push_exists", 409);
  store.pushes.push(push);
  await writePushStore(store, env);
  await appendEvent({
    type: "connector_prompt_push_created",
    pushId: push.id,
    ownerUserId: push.ownerUserId,
    connector: push.connector,
    targetType: push.targetType,
    target: push.target,
  }, env).catch(() => {});
  return push;
}

async function principalForPushOwner(push, env = process.env) {
  return await principalForUserId(push.ownerUserId, env) ||
    userPrincipal({ id: push.ownerUserId, role: push.ownerUserId === normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId) ? "admin" : "user", source: "connector-push-owner" });
}

async function assertConnectorPromptPushCapability(push, principal = null, env = process.env) {
  const actor = principal || await principalForPushOwner(push, env);
  assertOwnerAccess(actor, push.ownerUserId, "connector_prompt_push_access", env);
  if (isAdminPrincipal(actor)) return { actor, capabilities: { [push.connector]: true } };
  const thread = push.targetType === "thread" ? await getThreadForPrincipal(push.target, actor, env) : null;
  const capabilities = await userScopedCapabilityHints({ userId: push.ownerUserId, thread }, env);
  if (capabilities?.[push.connector] !== true) throw policyError("connector_prompt_push_capability_required", 403);
  return { actor, capabilities };
}

export async function createConnectorPromptPushForPrincipal(input = {}, principal, env = process.env) {
  const ownerUserId = isAdminPrincipal(principal)
    ? normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId)
    : normalizeUserId(principal?.userId);
  const push = normalizeConnectorPromptPush({ ...input, ownerUserId }, env);
  validateConnectorPromptPush(push);
  const capabilityContext = await assertConnectorPromptPushCapability(push, principal, env);
  if (!isAdminPrincipal(principal)) {
    await assertSanitizedAction({
      action: "connector_prompt_push.create",
      principal,
      resource: {
        type: "connector_prompt_push",
        id: push.id,
        ownerUserId: push.ownerUserId,
        connector: push.connector,
        targetType: push.targetType,
        target: push.target,
        capabilities: capabilityContext.capabilities,
      },
      input: {
        label: push.label,
        connector: push.connector,
        prompt: push.prompt.slice(0, maxPromptChars),
        sourceConfig: push.sourceConfig,
        safety: push.safety,
      },
    }, env);
  }
  return createConnectorPromptPush(push, env);
}

export async function updateConnectorPromptPush(id, patch = {}, env = process.env) {
  const pushId = clean(id);
  const store = await readPushStore(env);
  let updated = null;
  const pushes = store.pushes.map((entry) => {
    if (clean(entry.id) !== pushId) return entry;
    updated = normalizeConnectorPromptPush({
      ...entry,
      ...patch,
      sourceConfig: patch.sourceConfig || entry.sourceConfig,
      safety: patch.safety || entry.safety,
      schedule: patch.schedule || entry.schedule,
      id: entry.id,
      ownerUserId: entry.ownerUserId,
      connector: entry.connector,
      source: entry.source,
      createdAt: entry.createdAt,
    }, env);
    validateConnectorPromptPush(updated);
    return updated;
  });
  if (!updated) {
    const error = new Error("connector_prompt_push_not_found");
    error.statusCode = 404;
    throw error;
  }
  await writePushStore({ ...store, pushes }, env);
  await appendEvent({ type: "connector_prompt_push_updated", pushId: updated.id, ownerUserId: updated.ownerUserId, connector: updated.connector, targetType: updated.targetType, target: updated.target }, env).catch(() => {});
  return updated;
}

export async function updateConnectorPromptPushForPrincipal(id, patch = {}, principal, env = process.env) {
  const existing = await getConnectorPromptPush(id, env);
  if (!existing) throw promptPushError("connector_prompt_push_not_found", 404);
  assertOwnerAccess(principal, existing.ownerUserId, "connector_prompt_push_update", env);
  const updatedPreview = normalizeConnectorPromptPush({ ...existing, ...patch, id: existing.id, ownerUserId: existing.ownerUserId, connector: existing.connector, source: existing.source, createdAt: existing.createdAt }, env);
  validateConnectorPromptPush(updatedPreview);
  const capabilityContext = await assertConnectorPromptPushCapability(updatedPreview, principal, env);
  if (!isAdminPrincipal(principal)) {
    await assertSanitizedAction({
      action: "connector_prompt_push.update",
      principal,
      resource: { type: "connector_prompt_push", id: existing.id, ownerUserId: existing.ownerUserId, connector: existing.connector, targetType: updatedPreview.targetType, target: updatedPreview.target, capabilities: capabilityContext.capabilities },
      input: { label: updatedPreview.label, connector: updatedPreview.connector, prompt: updatedPreview.prompt.slice(0, maxPromptChars), promptTemplate: updatedPreview.promptTemplate.slice(0, maxPromptChars), sourceConfig: updatedPreview.sourceConfig, safety: updatedPreview.safety, enabled: updatedPreview.enabled },
    }, env);
  }
  return updateConnectorPromptPush(id, patch, env);
}

export async function deleteConnectorPromptPush(id, env = process.env) {
  const pushId = clean(id);
  const store = await readPushStore(env);
  const next = store.pushes.filter((entry) => clean(entry.id) !== pushId);
  if (next.length === store.pushes.length) return false;
  await writePushStore({ ...store, pushes: next }, env);
  await appendEvent({ type: "connector_prompt_push_deleted", pushId }, env).catch(() => {});
  return true;
}

export async function deleteConnectorPromptPushForPrincipal(id, principal, env = process.env) {
  const push = await getConnectorPromptPush(id, env);
  if (!push) return false;
  assertOwnerAccess(principal, push.ownerUserId, "connector_prompt_push_delete", env);
  return deleteConnectorPromptPush(id, env);
}

function sourceItemId(item = {}) {
  return clean(item.sourceItemId || item.id || item.messageId || item.externalId || item.threadId);
}

function clipped(value, length) {
  const text = clean(value);
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}...` : text;
}

function templateFields(push = {}, item = {}) {
  return {
    connector: push.connector || "",
    source: push.source || push.connector || "",
    sourceItemId: sourceItemId(item),
    id: sourceItemId(item),
    threadId: clean(item.threadId),
    subject: clean(item.subject),
    from: clean(item.from),
    to: clean(item.to),
    date: clean(item.date || item.internalDate),
    snippet: clean(item.snippet),
    text: clipped(item.text, push.safety?.bodyPreviewChars ?? defaultBodyPreviewChars),
    body: clipped(item.text || item.body, push.safety?.bodyPreviewChars ?? defaultBodyPreviewChars),
  };
}

function renderTemplate(template = "", fields = {}) {
  return clean(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => clean(fields[key]));
}

export function renderConnectorPrompt(push = {}, item = {}) {
  const fields = templateFields(push, item);
  const template = clean(push.promptTemplate || push.prompt);
  const rendered = renderTemplate(template, fields);
  if (rendered !== template || push.promptTemplate) return clipped(rendered, maxPromptChars);
  const context = [
    `Connector: ${fields.connector}`,
    fields.sourceItemId ? `Source item: ${fields.sourceItemId}` : "",
    fields.from ? `From: ${fields.from}` : "",
    fields.to ? `To: ${fields.to}` : "",
    fields.subject ? `Subject: ${fields.subject}` : "",
    fields.date ? `Date: ${fields.date}` : "",
    fields.snippet ? `Snippet: ${fields.snippet}` : "",
    fields.body ? `Body:\n${fields.body}` : "",
  ].filter(Boolean).join("\n");
  return clipped([rendered, context ? `Connector item:\n${context}` : ""].filter(Boolean).join("\n\n"), maxPromptChars);
}

function threadDeliveryDefaults(thread, input = {}) {
  const binding = thread?.binding || {};
  if (String(binding.connector || "").trim().toLowerCase() !== "whatsapp" && !binding.chatId) return input;
  const chatId = clean(input.chatId || binding.chatId);
  if (!chatId) return input;
  return {
    ...input,
    chatId,
    accountId: clean(
      input.accountId ||
      binding.responderAccountId ||
      binding.outboundAccountId ||
      binding.senderAccountId ||
      binding.inboundAccountId,
    ),
  };
}

async function enqueueConnectorPrompt(push, item, text, env = process.env) {
  const input = {
    source: "connector_prompt_push",
    connector: push.connector,
    originSurface: push.connector,
    originTransport: "prompt-push",
    visibility: "internal",
    externalId: sourceItemId(item),
    text,
    ownerUserId: push.ownerUserId,
  };
  if (push.targetType === "agent") return enqueueAgentMessage(push.target, input, env);
  const thread = await getThread(push.target, env);
  return enqueueThreadInput(thread?.id || push.target, threadDeliveryDefaults(thread, input), env);
}

async function updatePushAfterRun(push, result, env = process.env) {
  const store = await readPushStore(env);
  const now = nowIso();
  const deliveredIds = result.delivered.map((entry) => clean(entry.sourceItemId)).filter(Boolean);
  let updated = null;
  const nextPushes = store.pushes.map((entry) => {
    if (clean(entry.id) !== push.id) return entry;
    const processed = [...new Set([...(push.processedSourceItemIds || []), ...deliveredIds])].slice(-500);
    updated = {
      ...push,
      processedSourceItemIds: processed,
      lastRunAt: now,
      lastDeliveredAt: deliveredIds.length ? now : push.lastDeliveredAt || "",
      deliveredCount: Number(push.deliveredCount || 0) + deliveredIds.length,
      updatedAt: now,
    };
    return updated;
  });
  if (!updated) return push;
  await writePushStore({ ...store, pushes: nextPushes }, env);
  return updated;
}

export async function runConnectorPromptPush(pushOrId, sourceItems = [], env = process.env, options = {}) {
  const stored = typeof pushOrId === "string" ? await getConnectorPromptPush(pushOrId, env) : null;
  const push = normalizeConnectorPromptPush(stored || pushOrId, env);
  validateConnectorPromptPush(push);
  const result = {
    pushId: push.id,
    connector: push.connector,
    delivered: [],
    skipped: [],
    failed: [],
  };
  if (push.enabled !== true) {
    result.skipped.push({ reason: "disabled" });
    return result;
  }
  const lastRunMs = Date.parse(push.lastRunAt || "");
  const minIntervalMs = Math.max(0, Number(push.safety?.minIntervalMs || 0) || 0);
  if (!options.force && minIntervalMs && Number.isFinite(lastRunMs) && Date.now() - lastRunMs < minIntervalMs) {
    result.skipped.push({ reason: "min_interval", lastRunAt: push.lastRunAt });
    return result;
  }
  const capabilityContext = await assertConnectorPromptPushCapability(push, options.principal || null, env);
  const actor = capabilityContext.actor;
  const seen = new Set(push.processedSourceItemIds || []);
  const batchSeen = new Set();
  const candidates = [];
  for (const item of Array.isArray(sourceItems) ? sourceItems : []) {
    const id = sourceItemId(item);
    if (!id) {
      result.skipped.push({ reason: "missing_source_item_id" });
      continue;
    }
    if (seen.has(id) || batchSeen.has(id)) {
      result.skipped.push({ reason: "duplicate", sourceItemId: id });
      continue;
    }
    batchSeen.add(id);
    candidates.push({ ...item, sourceItemId: id });
  }
  for (const item of candidates.slice(0, push.safety.maxItemsPerRun)) {
    const text = renderConnectorPrompt(push, item);
    try {
      if (!isAdminPrincipal(actor)) {
        await assertSanitizedAction({
          action: "connector_prompt_push.execute",
          principal: actor,
          resource: {
            type: "connector_prompt_push",
            id: push.id,
            ownerUserId: push.ownerUserId,
            connector: push.connector,
            targetType: push.targetType,
            target: push.target,
            capabilities: capabilityContext.capabilities,
          },
          input: {
            sourceItemId: item.sourceItemId,
            subject: item.subject || "",
            from: item.from || "",
            prompt: text.slice(0, maxPromptChars),
          },
        }, env);
      }
      const message = await enqueueConnectorPrompt(push, item, text, env);
      result.delivered.push({ sourceItemId: item.sourceItemId, messageId: message.id, target: push.target });
    } catch (error) {
      result.failed.push({ sourceItemId: item.sourceItemId, error: error?.message || String(error) });
    }
  }
  for (const item of candidates.slice(push.safety.maxItemsPerRun)) {
    result.skipped.push({ reason: "batch_cap", sourceItemId: item.sourceItemId });
  }
  result.push = await updatePushAfterRun(push, result, env);
  await appendEvent({
    type: "connector_prompt_push_run",
    pushId: push.id,
    ownerUserId: push.ownerUserId,
    connector: push.connector,
    targetType: push.targetType,
    target: push.target,
    delivered: result.delivered.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
  }, env).catch(() => {});
  return result;
}
