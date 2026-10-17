// "Message yourself" as a home chat for several threads (self-hosted WhatsApp).
//
// The thread bound to the owner's own chat (binding.privateOwnerChat) is the
// home thread. From that chat the owner can talk to other threads:
//   @name text      send this one message to thread "name"
//   quote-reply     reply to a "[name] ..." message to answer that thread
//   /switch name    keep sending to "name" until /switch (alone) goes home
//   /threads        list the threads you can address
// Replies from another thread come back to the home chat as "[name] text".
// Only the owner's own messages (fromMe) are routed; targets must belong to
// the same owner and be unbound (or the home thread itself).
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { isThreadRetired } from "../../core/src/threads.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { ownerSelfChatScope, ownerSelfChatIngress } from './whatsapp-owner-selfchat-scope.js';

const maxReplyIndex = 500;

function clean(value = "") {
  return String(value || "").trim();
}

function homeChatStatePath(env = process.env) {
  return `${dataPaths(env).home}/whatsapp-home-chat.json`;
}

async function readHomeChatState(env = process.env) {
  const state = await readJson(homeChatStatePath(env), {}).catch(() => ({}));
  return {
    focus: state && typeof state.focus === "object" && !Array.isArray(state.focus) ? state.focus : {},
    replies: Array.isArray(state?.replies) ? state.replies : [],
  };
}

async function writeHomeChatState(state, env = process.env) {
  await writeJson(homeChatStatePath(env), {
    focus: state.focus || {},
    replies: (state.replies || []).slice(-maxReplyIndex),
  });
}

export function isHomeChatBinding(binding = {}, chatId = "") {
  return binding?.privateOwnerChat === true && Boolean(chatId) && clean(binding.chatId) === clean(chatId);
}

// Parses the home-chat directives. Returns null for ordinary messages.
export function parseHomeChatDirective(text = "") {
  const value = clean(text);
  if (/^\/threads$/i.test(value)) return { kind: "threads" };
  const switched = value.match(/^\/switch(?:\s+(\S+))?$/i);
  if (switched) return { kind: "switch", target: clean(switched[1]) };
  const addressed = value.match(/^@([A-Za-z0-9][\w.-]*)[\s:,]+([\s\S]+)$/);
  if (addressed) return { kind: "address", target: addressed[1], text: clean(addressed[2]) };
  return null;
}

function threadLabel(thread = {}) {
  return clean(thread.name || thread.bindingName || thread.id);
}

function threadMatchesName(thread = {}, name = "") {
  const wanted = clean(name).toLowerCase();
  return Boolean(wanted) && [thread.id, thread.name, thread.bindingName].some((value) => clean(value).toLowerCase() === wanted);
}

// Threads the owner may address from the home chat.
export function homeChatTargets(threads = [], homeThread = {}, chatId = "", env = process.env, scope = null) {
  const owner = resourceOwnerUserId(homeThread, env);
  return threads.filter((thread) => {
    if (!thread?.id || isThreadRetired(thread)) return false;
    if (resourceOwnerUserId(thread, env) !== owner) return false;
    // An explicit private scope can address existing groups without rebinding them.
    if (scope) return scope.threadIds.includes(thread.id);
    // Threads with their own WhatsApp chat (any other binding, enabled or
    // not) are only reachable there; the home chat addresses unbound threads.
    const binding = thread.binding || {};
    if (!clean(binding.chatId)) return true;
    return clean(binding.chatId) === clean(chatId) && binding.enabled !== false;
  });
}

// What to type after @ or /switch: one word, the name when it is one word.
export function homeChatAddress(thread = {}) {
  const name = clean(thread.name);
  return /^[A-Za-z0-9][\w.-]*$/.test(name) ? name : clean(thread.id);
}

export function formatHomeChatThreadList(targets = [], homeThread = {}, focusId = "") {
  const lines = targets.map((thread, index) => {
    const marks = [thread.id === homeThread.id ? "home" : "", thread.id === focusId ? "current" : ""].filter(Boolean);
    const address = homeChatAddress(thread);
    const label = threadLabel(thread);
    return `${index + 1}. ${label}${address !== label ? ` (@${address})` : ""}${marks.length ? ` (${marks.join(", ")})` : ""}`;
  });
  return [
    "Threads you can message from this chat:",
    ...lines,
    "",
    "Write @name message to send one message, or /switch name to keep talking to it. /switch alone comes back here. Reply to a [name] message to answer that thread.",
  ].join("\n");
}

// Remembers which thread sent a WhatsApp message into the home chat, so a
// quote-reply can be routed back to it.
export async function recordHomeChatReply({ chatId, threadId, messageIds = [] } = {}, env = process.env) {
  const ids = messageIds.map(clean).filter(Boolean);
  if (!ids.length || !clean(chatId) || !clean(threadId)) return;
  const state = await readHomeChatState(env);
  state.replies = [...state.replies.filter((entry) => !ids.includes(entry.messageId)), ...ids.map((messageId) => ({ messageId, chatId: clean(chatId), threadId: clean(threadId) }))];
  await writeHomeChatState(state, env);
}

// Decides where a home-chat message goes. Returns null when the message is
// not from the owner's home chat (normal routing applies), otherwise:
//   { reply }                              a command answered by the router
//   { threadId, text, routed: boolean }    route text to threadId
export async function resolveHomeChatRoute({ input = {}, threadRoute = {}, threads = [] } = {}, env = process.env) {
  const chatId = clean(input.chatId);
  const fromMe = input.fromMe === true || clean(input.fromMe).toLowerCase() === "true";
  if (!fromMe || !isHomeChatBinding(threadRoute.binding, chatId)) return null;
  const homeThread = threads.find((thread) => thread.id === threadRoute.threadId || thread.name === threadRoute.threadId);
  if (!homeThread) return null;
  const configured = ownerSelfChatScope(env);
  const scope = ownerSelfChatIngress(configured, input, homeThread, threadRoute.binding) ? configured : null;
  if ((env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE || clean(homeThread.binding?.chatId) !== chatId) && !scope)
    return { blocked:'owner_selfchat_scope_required' };
  const targets = homeChatTargets(threads, homeThread, chatId, env, scope);
  const origin = scope ? { ownerSelfChatOrigin:{ revision:scope.revision, homeThreadId:scope.homeThreadId } } : {};
  const state = await readHomeChatState(env);
  const focusId = clean(state.focus[chatId]);
  const directive = parseHomeChatDirective(input.text);
  if (directive?.kind === "threads") return { reply: formatHomeChatThreadList(targets, homeThread, focusId), ...origin };
  if (directive?.kind === "switch") {
    const target = directive.target ? targets.find((thread) => threadMatchesName(thread, directive.target)) : targets.find(t => t.id === homeThread.id);
    if (!target) return { reply: `No thread called "${directive.target}". Write /threads to see the list.`, ...origin };
    if (target.id === homeThread.id) delete state.focus[chatId];
    else state.focus[chatId] = target.id;
    await writeHomeChatState(state, env);
    return { reply: target.id === homeThread.id ? `Back to ${threadLabel(homeThread)}.` : `Now talking to ${threadLabel(target)}. Write /switch to come back.`, ...origin };
  }
  if (directive?.kind === "address") {
    const target = targets.find((thread) => threadMatchesName(thread, directive.target));
    if (target) return { threadId: target.id, text: directive.text, routed: target.id !== homeThread.id, ...origin };
    return { reply: `No thread called "${directive.target}". Write /threads to see the list.`, ...origin };
  }
  const quotedId = clean(input.quoted?.messageId);
  if (quotedId) {
    const entry = state.replies.find((item) => item.messageId === quotedId && item.chatId === chatId);
    const target = entry && targets.find((thread) => thread.id === entry.threadId);
    if (target) return { threadId: target.id, text: clean(input.text), routed: target.id !== homeThread.id, ...origin };
  }
  const focused = focusId && targets.find((thread) => thread.id === focusId);
  if (focused && focused.id !== homeThread.id) return { threadId: focused.id, text: clean(input.text), routed: true, ...origin };
  if (scope && !targets.some(t => t.id === homeThread.id)) return { reply:'Choose a permitted thread with /threads.', ...origin };
  return { threadId: homeThread.id, text: clean(input.text), routed: false, ...origin };
}

// "[name] text" for replies that a non-home thread sends into the home chat.
export function homeChatReplyText(text = "", thread = {}) {
  const label = threadLabel(thread);
  const value = String(text || "");
  return label && !value.startsWith(`[${label}]`) ? `[${label}] ${value}` : value;
}
