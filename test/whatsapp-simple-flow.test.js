import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, getThread } from "../packages/core/src/threads.js";
import { autoConnectHomeChat, autoHomeChatEnabled } from "../packages/connectors/src/whatsapp-auto-home-chat.js";
import { whatsappReachLabel } from "../apps/web/src/app/whatsapp-thread-reach.ts";

const self = "15550000001@c.us";

async function home() {
  return { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-auto-home-")), ORKESTR_ADMIN_USER_ID: "admin" };
}

test("auto home chat is on in the Docker image only, unless forced", () => {
  assert.equal(autoHomeChatEnabled({ ORKESTR_DOCKER: "1" }), true);
  assert.equal(autoHomeChatEnabled({}), false);
  assert.equal(autoHomeChatEnabled({ ORKESTR_DOCKER: "1", ORKESTR_WHATSAPP_AUTO_HOME_CHAT: "0" }), false);
  assert.equal(autoHomeChatEnabled({ ORKESTR_WHATSAPP_AUTO_HOME_CHAT: "1" }), true);
});

test("linking WhatsApp connects Message yourself to the orkestr thread, once, nobody else added", async () => {
  const env = { ...(await home()), ORKESTR_DOCKER: "1" };
  await createThread({ id: "orkestr", name: "orkestr", ownerUserId: "admin", executorId: "noop" }, env);
  await createThread({ id: "other", name: "other", ownerUserId: "admin", executorId: "noop" }, env);
  assert.deepEqual(await autoConnectHomeChat({ accountId: "account-1", contactId: self }, env), { connected: true, threadId: "orkestr" });
  const binding = (await getThread("orkestr", env)).binding;
  assert.equal(binding.privateOwnerChat, true);
  assert.equal(binding.chatId, self);
  assert.deepEqual(binding.ownerParticipantIds, [self]);
  assert.equal((await autoConnectHomeChat({ accountId: "account-1", contactId: self }, env)).skipped, "already_connected");
  assert.equal((await getThread("other", env)).binding?.chatId || "", "", "other threads stay unbound");
});

test("auto home chat leaves ambiguous, bound-only and non-Docker installs alone", async () => {
  const ambiguous = { ...(await home()), ORKESTR_DOCKER: "1" };
  await createThread({ id: "a", name: "a", ownerUserId: "admin", executorId: "noop" }, ambiguous);
  await createThread({ id: "b", name: "b", ownerUserId: "admin", executorId: "noop" }, ambiguous);
  assert.equal((await autoConnectHomeChat({ accountId: "account-1", contactId: self }, ambiguous)).skipped, "ambiguous");

  const single = { ...(await home()), ORKESTR_DOCKER: "1" };
  await createThread({ id: "grouped", name: "grouped", ownerUserId: "admin", executorId: "noop", binding: { connector: "whatsapp", chatId: "120363000000000000@g.us", enabled: true } }, single);
  await createThread({ id: "only", name: "only", ownerUserId: "admin", executorId: "noop" }, single);
  assert.deepEqual(await autoConnectHomeChat({ accountId: "account-1", contactId: self }, single), { connected: true, threadId: "only" }, "a single unbound thread is used; bound ones are never rebound");

  const production = await home();
  await createThread({ id: "orkestr", name: "orkestr", ownerUserId: "admin", executorId: "noop" }, production);
  assert.equal((await autoConnectHomeChat({ accountId: "account-1", contactId: self }, production)).skipped, "disabled");
  assert.equal((await autoConnectHomeChat({ accountId: "account-1", contactId: "51300000000001@lid" }, { ...production, ORKESTR_DOCKER: "1" })).skipped, "no_owner_contact");
});

test("thread header badge says how a thread is reachable from WhatsApp", () => {
  const homeThread = { id: "orkestr", name: "orkestr", binding: { privateOwnerChat: true, chatId: self } };
  const unbound = { id: "p-alpha", name: "Project Alpha" };
  const grouped = { id: "g", name: "g", binding: { chatId: "1203@g.us", displayName: "orkestr · g", enabled: true } };
  const disabled = { id: "d", name: "d", binding: { chatId: "1204@g.us", enabled: false } };
  const threads = [homeThread, unbound, grouped, disabled];
  assert.equal(whatsappReachLabel(homeThread, threads), "WhatsApp: Message yourself");
  assert.equal(whatsappReachLabel(unbound, threads), "WhatsApp: @p-alpha", "one-word address for names with spaces");
  assert.equal(whatsappReachLabel(grouped, threads), "WhatsApp: orkestr · g");
  assert.equal(whatsappReachLabel(disabled, threads), "");
  assert.equal(whatsappReachLabel(unbound, [unbound]), "", "no badge without a home chat");
});

test("web chat marks messages that crossed WhatsApp; Setup shows two steps and an Advanced area", async () => {
  const list = await fs.readFile("apps/web/src/app/thread-message-list.component.ts", "utf8");
  assert.match(list, /return "from WhatsApp"/);
  assert.match(list, /return "sent to WhatsApp"/);
  const setup = await fs.readFile("apps/web/src/app/onboarding-page.component.html", "utf8");
  assert.match(setup, /1\. Link your phone/);
  assert.match(setup, /2\. Chat in "Message yourself"/);
  assert.match(setup, /<details class="wa-advanced"/);
  const app = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  assert.match(app, /<details class="wa-advanced">\s*<summary>Advanced: accounts, groups and chat settings<\/summary>/);
});
