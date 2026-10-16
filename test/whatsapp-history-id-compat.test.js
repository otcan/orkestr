import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { stripWhatsAppHistoryIdPatch } from "../scripts/whatsapp-history-id-compat.mjs";

const require = createRequire(import.meta.url);
const Chat = require("whatsapp-web.js/src/structures/Chat.js");
const installed = await fs.readFile(require.resolve("whatsapp-web.js/src/util/Injected/Utils.js"), "utf8");
const before = stripWhatsAppHistoryIdPatch(installed);
const phoneId = "15550000001@c.us";
const lidId = "10000000001@lid";

function fixture(source, { keyFormat = "$1", lid = false, knownAlias = true, missingKey = false, group = false, loadedLastMessage = true } = {}) {
  const wid = (id) => ({ [keyFormat]: id, user: id.split("@")[0], server: id.split("@")[1] });
  const chatId = group ? "15550000001-1@g.us" : lid ? lidId : phoneId;
  const key = { [keyFormat]: `false_${chatId}_fixture`, remote: wid(chatId), fromMe: false, id: "fixture" };
  const messageData = { id: key, from: wid(chatId), to: wid("15550000002@c.us"), author: wid(phoneId), body: "fixture reply", type: "chat", t: 1700000000 };
  const message = { ...messageData, serialize: () => ({ ...messageData }) };
  const chat = {
    id: wid(chatId), unreadCount: 2, mute: { expiration: 0 }, formattedTitle: "Fixture",
    lastReceivedKey: missingKey ? { id: "unserializable" } : key,
    msgs: { getModelsArray: () => [message] },
    serialize: () => ({ id: wid(chatId), unreadCount: 2, t: 1700000000, msgs: [messageData] }),
    ...(group ? { groupMetadata: { announce: false, serialize: () => ({ participants: [{ id: wid(phoneId) }] }) } } : {}),
  };
  const lookups = [];
  const idString = value => typeof value === "string" ? value : value?._serialized || value?.$1;
  const modules = {
    WALinkify: { findLinks: () => [] },
    WAWebWidFactory: { createWid: id => { assert.equal(typeof id, "string"); return wid(id); } },
    WAWebApiContact: {
      getAlternateUserWid: id => knownAlias && idString(id) === phoneId ? wid(lidId) : null,
      getPhoneNumber: id => knownAlias && idString(id) === lidId ? wid(phoneId) : null,
    },
    WAWebCollections: {
      Chat: { get: id => idString(id) === chatId ? chat : undefined, getModelsArray: () => [chat] },
      Msg: {
        get: id => {
          lookups.push(id);
          if (!id) throw Error("r");
          assert.equal(id, key[keyFormat]);
          return loadedLastMessage ? message : undefined;
        },
        getMessagesById: async ids => {
          assert.deepEqual(Array.from(ids), [key[keyFormat]]);
          return { messages: [message] };
        },
      },
      GroupMetadata: { update: async id => assert.equal(idString(id), chatId) },
    },
    WAWebLidMigrationUtils: { toPn: id => id },
    WAWebFindChatAction: { findOrCreateLatestChat: async () => { throw Error("unexpected_chat_creation"); } },
  };
  const context = vm.createContext({ exports: {}, window: { require(name) {
    // Any read receipt or send API would fail this fixture.
    assert.ok(modules[name], `unexpected module: ${name}`);
    return modules[name];
  } } });
  vm.runInContext(source, context);
  context.exports.LoadUtils();
  const client = { pupPage: { evaluate: async (callback, ...args) => {
    context.args = args;
    return vm.runInContext(`(${callback.toString()})(...args)`, context);
  } } };
  return { api: context.window.WWebJS, client, chat, key, lookups, chatId };
}

test("real injected dependency reproduces r on both list and single-chat read", async () => {
  const { api } = fixture(before);
  await assert.rejects(api.getChats(), /^Error: r$/);
  await assert.rejects(api.getChat(phoneId), /^Error: r$/);
});

for (const keyFormat of ["_serialized", "$1"]) {
  test(`list and actual Chat.fetchMessages preserve identities and unread state (${keyFormat})`, async () => {
    const { api, client, chat, key, chatId } = fixture(installed, { keyFormat });
    const chats = await api.getChats();
    assert.equal(chats.length, 1);
    assert.equal(chats[0].id._serialized, chatId);
    assert.equal(chats[0].unreadCount, 2);
    assert.equal(chats[0].lastMessage.id._serialized, key[keyFormat]);
    const wrapped = new Chat(client, await api.getChat(chatId));
    const messages = await wrapped.fetchMessages({ limit: 1 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id._serialized, key[keyFormat]);
    assert.equal(messages[0].id.remote, chatId);
    assert.equal(messages[0].body, "fixture reply");
    assert.equal(messages[0].from, chatId);
    assert.equal(messages[0].to, "15550000002@c.us");
    assert.equal(messages[0].author, phoneId);
    assert.equal(messages[0].timestamp, 1700000000);
    assert.equal(chat.unreadCount, 2);
    if (keyFormat === "$1") assert.equal(Object.hasOwn(key, "_serialized"), false);
  });
}

test("phone-scoped list and history use only WhatsApp's confirmed LID mapping", async () => {
  const { api, client, chat } = fixture(installed, { lid: true });
  assert.equal((await api.getChats())[0].id._serialized, phoneId);
  const wrapped = new Chat(client, await api.getChat(phoneId));
  const messages = await wrapped.fetchMessages({ limit: 1 });
  assert.equal(messages[0].id._serialized, `false_${lidId}_fixture`);
  assert.equal(chat.unreadCount, 2);
});

test("unknown LID remains unchanged and cannot resolve an unrelated phone", async () => {
  const { api } = fixture(installed, { lid: true, knownAlias: false });
  assert.equal((await api.getChats())[0].id._serialized, lidId);
  await assert.rejects(api.getChat(phoneId), /unexpected_chat_creation/);
});

test("missing last-message identity never performs an undefined store lookup", async () => {
  const { api, lookups } = fixture(installed, { missingKey: true });
  assert.equal((await api.getChats())[0].lastMessage, null);
  assert.deepEqual(lookups, []);
});

test("uncached last message uses its renamed key for loading", async () => {
  const { api } = fixture(installed, { loadedLastMessage: false });
  assert.equal((await api.getChats())[0].lastMessage.body, "fixture reply");
});

test("group metadata and participant IDs support renamed serialized fields", async () => {
  const { api, chatId } = fixture(installed, { group: true });
  const model = (await api.getChats())[0];
  assert.equal(model.id._serialized, chatId);
  assert.equal(model.isGroup, true);
  assert.equal(model.groupMetadata.participants[0].id._serialized, phoneId);
});
