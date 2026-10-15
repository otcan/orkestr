import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, getThread, listThreadMessages } from "../packages/core/src/threads.js";
import { bindThreadToPrivateOwnerChat } from "../packages/connectors/src/whatsapp-onboarding-private-chat.js";
import { homeChatReplyText, parseHomeChatDirective, recordHomeChatReply } from "../packages/connectors/src/whatsapp-home-chat.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";

const self = "15550000001@c.us";

test("home chat directives: @name, /switch, /threads; ordinary text is untouched", () => {
  assert.deepEqual(parseHomeChatDirective("@projectx fix the login bug"), { kind: "address", target: "projectx", text: "fix the login bug" });
  assert.deepEqual(parseHomeChatDirective("@projectx: hi"), { kind: "address", target: "projectx", text: "hi" });
  assert.deepEqual(parseHomeChatDirective("/switch projectx"), { kind: "switch", target: "projectx" });
  assert.deepEqual(parseHomeChatDirective("/SWITCH"), { kind: "switch", target: "" });
  assert.deepEqual(parseHomeChatDirective("/threads"), { kind: "threads" });
  assert.equal(parseHomeChatDirective("mail me@example.test about it"), null);
  assert.equal(parseHomeChatDirective("@projectx"), null, "a bare mention is not a message");
  assert.equal(homeChatReplyText("Done.", { name: "projectx" }), "[projectx] Done.");
  assert.equal(homeChatReplyText("[projectx] Done.", { name: "projectx" }), "[projectx] Done.");
});

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-home-chat-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_CONNECTOR_OUTBOX_STORE: "json", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" };
  const orkestr = await createThread({ id: "orkestr", name: "orkestr", ownerUserId: "admin", executorId: "noop" }, env);
  await bindThreadToPrivateOwnerChat(orkestr, { accountId: "account-1", contactId: self, name: "orkestr" }, env);
  await createThread({ id: "projectx", name: "projectx", ownerUserId: "admin", executorId: "noop" }, env);
  await createThread({ id: "elsewhere", name: "elsewhere", ownerUserId: "admin", executorId: "noop",
    binding: { connector: "whatsapp", chatId: "someone-else@g.us", enabled: true, ownerParticipantIds: ["15559990000@c.us"] } }, env);
  await createThread({ id: "theirs", name: "theirs", ownerUserId: "casey", executorId: "noop" }, env);
  // Same owner, own (disabled) group whose binding lists the owner: still not addressable.
  await createThread({ id: "grouped", name: "grouped", ownerUserId: "admin", executorId: "noop",
    binding: { connector: "whatsapp", chatId: "different-group@g.us", enabled: false, ownerParticipantIds: [self] } }, env);
  let counter = 0;
  const send = (text, extra = {}) => routeWhatsAppInbound({
    eventId: `evt-${++counter}`, chatId: self, from: self, fromMe: true, accountId: "account-1", text, ...extra,
  }, env);
  const userTexts = async (threadId) => (await listThreadMessages(threadId, env)).filter((message) => message.role === "user").map((message) => message.text);
  const lastReply = async (threadId) => (await listThreadMessages(threadId, env)).filter((message) => message.role === "assistant").at(-1)?.text || "";
  return { env, send, userTexts, lastReply };
}

test("Message yourself routes to the home thread, @name and /switch reach other threads of the same owner", async (t) => {
  const f = await fixture(t);
  await f.send("hello home");
  assert.deepEqual(await f.userTexts("orkestr"), ["hello home"]);

  const addressed = await f.send("@projectx fix the login bug");
  assert.equal(addressed.threadId, "projectx");
  assert.deepEqual(await f.userTexts("projectx"), ["fix the login bug"]);
  const routed = (await listThreadMessages("projectx", f.env)).find((message) => message.role === "user");
  assert.equal(String(routed.homeChatRouted), "true");
  assert.equal(routed.chatId, self, "the reply goes back to the home chat");
  assert.equal((await getThread("projectx", f.env)).whatsappHomeChat.chatId, self, "projectx replies are scanned for WhatsApp");
  assert.equal((await getThread("projectx", f.env)).binding?.chatId || "", "", "projectx is not bound to the home chat");

  await f.send("/switch projectx");
  assert.match(await f.lastReply("orkestr"), /Now talking to projectx/);
  await f.send("and the signup page");
  assert.deepEqual(await f.userTexts("projectx"), ["fix the login bug", "and the signup page"]);
  await f.send("/switch");
  await f.send("back home");
  assert.equal((await f.userTexts("orkestr")).at(-1), "back home");

  await f.send("/threads");
  const list = await f.lastReply("orkestr");
  assert.match(list, /orkestr \(home\)/);
  assert.match(list, /projectx/);
  assert.doesNotMatch(list, /elsewhere|theirs|grouped/, "threads bound to other chats or other owners are not offered");

  await f.send("@elsewhere hi");
  assert.match(await f.lastReply("orkestr"), /No thread called "elsewhere"/);
  await f.send("@grouped run this");
  assert.deepEqual(await f.userTexts("grouped"), [], "a thread with its own chat is not reachable from the home chat");
  assert.match(await f.lastReply("orkestr"), /No thread called "grouped"/);
  await f.send("@theirs hi");
  assert.deepEqual(await f.userTexts("theirs"), [], "another user's thread is never reachable");
});

test("a quote-reply to a [projectx] message goes to projectx; other people in the chat are not routed", async (t) => {
  const f = await fixture(t);
  await recordHomeChatReply({ chatId: self, threadId: "projectx", messageIds: ["wa-out-1"] }, f.env);
  const quoted = await f.send("yes, do it", { quoted: { messageId: "wa-out-1", from: self, text: "[projectx] Shall I?" } });
  assert.equal(quoted.threadId, "projectx");
  assert.deepEqual(await f.userTexts("projectx"), ["yes, do it"]);

  const notMine = await routeWhatsAppInbound({ eventId: "evt-other", chatId: self, from: "15559990000@c.us", fromMe: false, accountId: "account-1", text: "@projectx hi" }, f.env).catch((error) => ({ error }));
  assert.notEqual(notMine.threadId, "projectx", "only the owner's own messages are routed");
});

test("a reply from an addressed thread comes back to the home chat as [name], and quoting it answers that thread", async (t) => {
  const { writeConnectorConfig } = await import("../packages/storage/src/config.js");
  const { appendThreadMessage } = await import("../packages/core/src/threads.js");
  const { deliverWhatsAppReplies } = await import("../packages/connectors/src/whatsapp.js");
  const f = await fixture(t);
  f.env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED = "1";
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://bridge.local/api/connectors/whatsapp/bridge" }, f.env);
  await f.send("@projectx is the build green?");
  const routed = (await listThreadMessages("projectx", f.env)).find((message) => message.role === "user");
  await appendThreadMessage("projectx", { role: "assistant", phase: "final_answer", state: "completed", text: "Yes, all green.", parentMessageId: routed.id }, f.env);
  const sent = [];
  await deliverWhatsAppReplies(f.env, async (url, options = {}) => {
    if (String(url.pathname || url).endsWith("/send-text")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, ids: ["wa-sent-7"] }), text: async () => JSON.stringify({ ok: true, ids: ["wa-sent-7"] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ready: true, accounts: [{ id: "account-1", ready: true, state: "ready", contactId: self }] }), text: async () => "{}" };
  }, { fresh: true });
  const reply = sent.find((body) => /all green/.test(body.text));
  assert.ok(reply, "the projectx reply was sent");
  assert.equal(reply.to, self);
  assert.match(reply.text, /^\[projectx\] Yes, all green\./);

  const quoted = await f.send("great, deploy it", { quoted: { messageId: "wa-sent-7", from: self, text: reply.text } });
  assert.equal(quoted.threadId, "projectx", "quoting the [projectx] reply answers projectx");
});
