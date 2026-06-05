import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { appendThreadMessage, getThread, getThreadForPrincipal } from "./threads.js";

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

export function normalizeApiSessionId(value) {
  return clean(value).replace(/\s+/g, " ");
}

function apiSessionIdFromInput(input = {}) {
  return normalizeApiSessionId(input.apiSessionId || input.sessionId || input.codexApiSessionId || input.apiThreadId);
}

function bindingStoreDefaults(raw = {}) {
  return {
    schemaVersion: 1,
    bindings: Array.isArray(raw?.bindings) ? raw.bindings : [],
    updatedAt: clean(raw?.updatedAt),
  };
}

async function readBindingStore(env = process.env) {
  return bindingStoreDefaults(await readJson(dataPaths(env).apiSessionBindings, { schemaVersion: 1, bindings: [] }));
}

async function writeBindingStore(store, env = process.env) {
  const next = bindingStoreDefaults(store);
  next.updatedAt = nowIso();
  await writeJson(dataPaths(env).apiSessionBindings, next);
  return next;
}

function safeMetadata(input = {}) {
  const metadata = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const output = {};
  for (const [key, value] of Object.entries(metadata)) {
    const name = clean(key);
    if (!name || /token|secret|password|authorization|api[_-]?key|cookie/i.test(name)) continue;
    if (["string", "number", "boolean"].includes(typeof value)) {
      output[name] = clean(value).slice(0, 500);
    }
  }
  return output;
}

function apiSessionError(message, statusCode, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

async function readableThread(threadId, principal = null, env = process.env) {
  return principal ? getThreadForPrincipal(threadId, principal, env) : getThread(threadId, env);
}

function publicBinding(binding = null) {
  if (!binding) return null;
  return {
    apiSessionId: clean(binding.apiSessionId),
    threadId: clean(binding.threadId),
    source: clean(binding.source) || null,
    cwd: clean(binding.cwd) || null,
    createdAt: clean(binding.createdAt) || null,
    updatedAt: clean(binding.updatedAt) || null,
    lastSeenAt: clean(binding.lastSeenAt) || null,
    lastMessageAt: clean(binding.lastMessageAt) || null,
    lastMessageRole: clean(binding.lastMessageRole) || null,
    ownerUserId: clean(binding.ownerUserId) || null,
    metadata: binding.metadata && typeof binding.metadata === "object" ? binding.metadata : {},
  };
}

export async function getApiSessionBinding(apiSessionId, env = process.env) {
  const id = normalizeApiSessionId(apiSessionId);
  if (!id) return null;
  const store = await readBindingStore(env);
  return store.bindings.find((binding) => clean(binding.apiSessionId) === id) || null;
}

export async function getApiSessionBindingForPrincipal(apiSessionId, principal = null, env = process.env) {
  const binding = await getApiSessionBinding(apiSessionId, env);
  if (!binding) return null;
  await readableThread(binding.threadId, principal, env);
  return publicBinding(binding);
}

export async function bindApiSessionToThread(input = {}, env = process.env, principal = null) {
  const apiSessionId = apiSessionIdFromInput(input);
  if (!apiSessionId) throw apiSessionError("api_session_id_required", 400);
  const threadId = clean(input.threadId || input.orkestrThreadId);
  if (!threadId) throw apiSessionError("api_session_thread_required", 400);
  const thread = await readableThread(threadId, principal, env);
  if (!thread) throw apiSessionError("thread_not_found", 404);

  const store = await readBindingStore(env);
  const now = nowIso();
  const index = store.bindings.findIndex((binding) => clean(binding.apiSessionId) === apiSessionId);
  const previous = index >= 0 ? store.bindings[index] : {};
  const binding = {
    ...previous,
    apiSessionId,
    threadId: thread.id,
    ownerUserId: clean(thread.ownerUserId || previous.ownerUserId),
    source: clean(input.source || previous.source || "api-session"),
    cwd: clean(input.cwd || previous.cwd),
    metadata: {
      ...(previous.metadata && typeof previous.metadata === "object" ? previous.metadata : {}),
      ...safeMetadata(input.metadata),
    },
    createdAt: clean(previous.createdAt) || now,
    updatedAt: now,
    lastSeenAt: now,
  };
  const nextBindings = [...store.bindings];
  if (index >= 0) nextBindings[index] = binding;
  else nextBindings.push(binding);
  await writeBindingStore({ ...store, bindings: nextBindings }, env);
  await appendEvent({
    type: index >= 0 ? "api_session_binding_updated" : "api_session_binding_created",
    apiSessionId,
    threadId: thread.id,
    source: binding.source,
  }, env).catch(() => {});
  return { binding: publicBinding(binding), thread };
}

export async function resolveApiSessionThread(input = {}, env = process.env, principal = null) {
  const apiSessionId = apiSessionIdFromInput(input);
  if (!apiSessionId) throw apiSessionError("api_session_id_required", 400);
  const binding = await getApiSessionBinding(apiSessionId, env);
  if (!binding) {
    throw apiSessionError("api_session_not_bound", 409, {
      apiSessionId,
      action: "bind_api_session_to_orkestr_thread",
    });
  }
  const thread = await readableThread(binding.threadId, principal, env);
  if (!thread) throw apiSessionError("api_session_thread_not_found", 404, { apiSessionId, threadId: binding.threadId });
  return { apiSessionId, binding: publicBinding(binding), thread };
}

function boundWhatsAppAssistantDefaults(thread = null, input = {}) {
  const binding = thread?.binding || {};
  if (lower(binding.connector || "whatsapp") !== "whatsapp") return input;
  if (binding.mirrorToWhatsApp === false || binding.mirrorReplies === false) return input;
  const chatId = clean(input.chatId || binding.chatId);
  if (!chatId) return input;
  return {
    ...input,
    connector: clean(input.connector || "whatsapp"),
    chatId,
    accountId: clean(
      input.accountId ||
      binding.responderAccountId ||
      binding.outboundAccountId ||
      binding.senderAccountId ||
      binding.inboundAccountId,
    ),
    originSurface: clean(input.originSurface || "api-session"),
    originTransport: clean(input.originTransport || "api-session"),
  };
}

async function touchBinding(apiSessionId, patch = {}, env = process.env) {
  const store = await readBindingStore(env);
  const index = store.bindings.findIndex((binding) => clean(binding.apiSessionId) === apiSessionId);
  if (index < 0) return null;
  const binding = {
    ...store.bindings[index],
    ...patch,
    updatedAt: nowIso(),
    lastSeenAt: nowIso(),
  };
  const bindings = [...store.bindings];
  bindings[index] = binding;
  await writeBindingStore({ ...store, bindings }, env);
  return publicBinding(binding);
}

export async function appendApiSessionMessage(input = {}, env = process.env, principal = null) {
  const { apiSessionId, binding, thread } = await resolveApiSessionThread(input, env, principal);
  const role = lower(input.role || "assistant");
  if (!["assistant", "user"].includes(role)) throw apiSessionError("api_session_message_role_invalid", 400);
  const text = clean(input.text || input.message || input.content);
  if (!text && !input.promptFile) throw apiSessionError("message_text_required", 400);
  const base = {
    ...input,
    role,
    text,
    source: clean(input.source || "api-session"),
    state: clean(input.state || "completed"),
    apiSessionId,
  };
  const messageInput = role === "assistant"
    ? boundWhatsAppAssistantDefaults(thread, {
        ...base,
        phase: clean(input.phase || "final_answer"),
      })
    : base;
  const message = await appendThreadMessage(thread.id, messageInput, env);
  const nextBinding = await touchBinding(apiSessionId, {
    lastMessageAt: message.createdAt || nowIso(),
    lastMessageRole: message.role,
    lastMessageId: message.id,
  }, env);
  await appendEvent({
    type: "api_session_message_appended",
    apiSessionId,
    threadId: thread.id,
    messageId: message.id,
    role: message.role,
    connector: message.connector || "",
  }, env).catch(() => {});
  return {
    binding: nextBinding || binding,
    thread,
    message,
    deliveryExpected: message.role === "assistant" && lower(message.connector) === "whatsapp" && Boolean(message.chatId),
  };
}
