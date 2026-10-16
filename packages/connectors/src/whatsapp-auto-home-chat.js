// When the owner links WhatsApp and no thread has their "Message yourself"
// chat yet, connect it to the main thread automatically (the same safe
// private-chat binding the first-run wizard uses: only the owner's own chat
// on that account, nobody added). Default on only for a simple personal
// Docker install (no broker/tenant routing, no identity provider, one user,
// account owned by that user); ORKESTR_WHATSAPP_AUTO_HOME_CHAT=1/0 forces it.
// Ambiguous installs and chats that are already bound are left alone.
import { appendEvent } from "../../storage/src/store.js";
import { isThreadRetired, listThreads } from "../../core/src/threads.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { listUsers } from "../../core/src/users.js";
import { authProvider } from "../../core/src/auth-config.js";
import { readWhatsAppConnectorAccounts } from "./whatsapp-account-registry.js";
import { bindThreadToPrivateOwnerChat } from "./whatsapp-onboarding-private-chat.js";

function clean(value = "") {
  return String(value || "").trim();
}

// Brokered/tenant instances route WhatsApp through other systems; identity
// providers mean several people sign in. Neither is a simple personal install.
function simplePersonalInstall(env = process.env) {
  // Any tenant marker (VM, slice, boundary of any kind) or broker link counts.
  const brokered = ["ORKESTR_BROKER_BASE_URL", "ORKESTR_DEMO_BROKER_BASE_URL", "ORKESTR_BROKER_INSTANCE_ID",
    "ORKESTR_TENANT_VM_ID", "ORKESTR_TENANT_SLICE_ID", "ORKESTR_TENANT_BOUNDARY"]
    .some((key) => clean(env[key]));
  return !brokered && authProvider(env) === "browser_pairing";
}

export function autoHomeChatEnabled(env = process.env) {
  const explicit = clean(env.ORKESTR_WHATSAPP_AUTO_HOME_CHAT).toLowerCase();
  if (["1", "true", "on", "yes"].includes(explicit)) return true;
  if (["0", "false", "off", "no"].includes(explicit)) return false;
  return clean(env.ORKESTR_DOCKER) === "1" && simplePersonalInstall(env);
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
  const users = deps.listUsers || listUsers;
  const accounts = deps.readAccounts || readWhatsAppConnectorAccounts;
  const account = clean(accountId);
  const contact = clean(contactId);
  if (!autoHomeChatEnabled(env)) return { skipped: "disabled" };
  if (!account || !contact.endsWith("@c.us")) return { skipped: "no_owner_contact" };
  const owner = resourceOwnerUserId({}, env);
  // Single-owner installs only: one user, and the linked account belongs to
  // them. An unreadable user or account list fails closed.
  let userList, accountList;
  try {
    userList = await users(env);
    accountList = await accounts(env);
  } catch {
    return { skipped: "owner_check_unavailable" };
  }
  if (!Array.isArray(userList) || !Array.isArray(accountList)) return { skipped: "owner_check_unavailable" };
  if (userList.filter((user) => user?.status !== "disabled").length > 1) return { skipped: "multi_user" };
  const record = accountList.find((item) =>
    [item?.accountId, item?.id, item?.runtimeAccountId].map(clean).includes(account));
  if (record && clean(record.ownerUserId) && clean(record.ownerUserId) !== owner) return { skipped: "account_owner_mismatch" };
  const threads = await list(env);
  // Any thread already bound to this chat (self-chat or not) keeps it.
  if (threads.some((thread) => clean(thread?.binding?.chatId) === contact)) return { skipped: "already_connected" };
  const candidates = threads.filter((thread) => isMainThreadCandidate(thread, owner, env));
  const named = candidates.find((thread) => clean(thread.id) === "orkestr" || clean(thread.name).toLowerCase() === "orkestr");
  const target = named || (candidates.length === 1 ? candidates[0] : null);
  if (!target) return { skipped: candidates.length ? "ambiguous" : "no_thread" };
  await bind(target, { accountId: account, contactId: contact, name: clean(target.name) || target.id }, env);
  await appendEvent({ type: "whatsapp_home_chat_auto_connected", accountId: account, threadId: target.id }, env).catch(() => {});
  return { connected: true, threadId: target.id };
}
