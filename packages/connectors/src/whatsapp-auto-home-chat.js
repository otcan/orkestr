// When the owner links WhatsApp and no thread has their "Message yourself"
// chat yet, connect it to the main thread automatically (the same safe
// private-chat binding the first-run wizard uses: only the owner's own chat
// on that account, nobody added). Default on in the Docker image only;
// ORKESTR_WHATSAPP_AUTO_HOME_CHAT=1/0 forces it on/off. Ambiguous installs
// (several unbound threads, none named "orkestr") are left alone.
import { appendEvent } from "../../storage/src/store.js";
import { isThreadRetired, listThreads } from "../../core/src/threads.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { bindThreadToPrivateOwnerChat } from "./whatsapp-onboarding-private-chat.js";

function clean(value = "") {
  return String(value || "").trim();
}

export function autoHomeChatEnabled(env = process.env) {
  const explicit = clean(env.ORKESTR_WHATSAPP_AUTO_HOME_CHAT).toLowerCase();
  if (["1", "true", "on", "yes"].includes(explicit)) return true;
  if (["0", "false", "off", "no"].includes(explicit)) return false;
  return clean(env.ORKESTR_DOCKER) === "1";
}

function isMainThreadCandidate(thread = {}, owner = "", env = process.env) {
  if (!thread?.id || isThreadRetired(thread)) return false;
  if (resourceOwnerUserId(thread, env) !== owner) return false;
  if (clean(thread.binding?.chatId)) return false;
  if (clean(thread.parentThreadId || thread.rootThreadId) || clean(thread.threadKind) === "task-agent") return false;
  return true;
}

export async function autoConnectHomeChat({ accountId = "", contactId = "" } = {}, env = process.env, deps = {}) {
  const list = deps.listThreads || listThreads;
  const bind = deps.bind || bindThreadToPrivateOwnerChat;
  const account = clean(accountId);
  const contact = clean(contactId);
  if (!autoHomeChatEnabled(env)) return { skipped: "disabled" };
  if (!account || !contact.endsWith("@c.us")) return { skipped: "no_owner_contact" };
  const threads = await list(env);
  if (threads.some((thread) => thread?.binding?.privateOwnerChat === true && clean(thread.binding.chatId) === contact)) {
    return { skipped: "already_connected" };
  }
  const owner = resourceOwnerUserId({}, env);
  const candidates = threads.filter((thread) => isMainThreadCandidate(thread, owner, env));
  const named = candidates.find((thread) => clean(thread.id) === "orkestr" || clean(thread.name).toLowerCase() === "orkestr");
  const target = named || (candidates.length === 1 ? candidates[0] : null);
  if (!target) return { skipped: candidates.length ? "ambiguous" : "no_thread" };
  await bind(target, { accountId: account, contactId: contact, name: clean(target.name) || target.id }, env);
  await appendEvent({ type: "whatsapp_home_chat_auto_connected", accountId: account, threadId: target.id }, env).catch(() => {});
  return { connected: true, threadId: target.id };
}
