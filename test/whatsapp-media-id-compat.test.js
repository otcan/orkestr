import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { mediaIdPatch, messageLookupPatch, originalMessageLookup, patchWhatsAppMediaIdSource } from "../scripts/patch-whatsapp-media-id.mjs";

const require = createRequire(import.meta.url);
const installed = await fs.readFile(require.resolve("whatsapp-web.js/src/util/Injected/Utils.js"), "utf8");
const original = installed.replace(mediaIdPatch, "").replace(messageLookupPatch, originalMessageLookup);

async function simulateSend(source, { media = true, group = false, mime = "application/pdf", keyFormat = "_serialized", collectionFallback = false, candidates = value => [value], sendRejected = false } = {}) {
  let result;
  class MsgKey { constructor(fields) { Object.assign(this, fields, { remote: fields.to, fromMe: fields.selfDir === "out" }, keyFormat ? { [keyFormat]: "fixture-message" } : {}); } static async newId() { return "fixture-id"; } }
  const sender = { _serialized: "fixture-sender" };
  const modules = {
    WAWebChatGetters: { getIsNewsletter: () => false, getIsBroadcast: () => false },
    WALinkify: { findLink: () => null },
    WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => sender, getMaybeMePnUser: () => sender },
    WAWebMsgKey: MsgKey,
    WAWebWidFactory: { asUserWidOrThrow: value => value },
    WAWebGetEphemeralFieldsMsgActionsUtils: { getEphemeralFields: () => ({}) },
    WAWebSendMsgChatAction: { addAndSendMsgToChat(_chat, message) {
      // WhatsApp models prefer the enumerable private ID over the public field.
      const modelId = Object.hasOwn(message, "__x_id") ? message.__x_id : message.id;
      if (!modelId) throw Error("Data passed to getter must include an id property (it's how we memoize) but got undefined");
      result = message; return [Promise.resolve(message), sendRejected ? Promise.reject(Error("send_rejected")) : Promise.resolve()];
    } },
    WAWebCollections: { Msg: { get: key => !collectionFallback && key === "fixture-message" ? result : undefined, getModelsArray: () => candidates(result) } },
  };
  const context = vm.createContext({ exports: {}, window: { require(name) { assert.ok(modules[name], name); return modules[name]; } } });
  vm.runInContext(source, context); context.exports.LoadUtils();
  const mediaModel = { __x_id: undefined, clientUrl: "fixture-upload", uploadhash: "fixture-hash", streamingSidecar: "fixture-sidecar", mediaHandle: "fixture-handle", toJSON: () => ({ mimetype: mime, type: "document" }) };
  context.window.WWebJS.processMediaData = async () => mediaModel;
  const chat = { id: { _serialized: "fixture-chat@g.us", isLid: () => false, isGroup: () => group, isStatus: () => false }, groupMetadata: { isLidAddressingMode: true } };
  return context.window.WWebJS.sendMessage(chat, "fixture-text", { waitUntilMsgSent: true, ...(media ? { media: {}, caption: "fixture-caption", sendMediaAsDocument: !mime.startsWith("image/") } : {}) });
}

test("old lookup loses the real send result when the serialized key is renamed", async () => {
  const oldPatch = original.replace("        // Bot's won't reply if canonicalUrl is set (linking)", mediaIdPatch + "        // Bot's won't reply if canonicalUrl is set (linking)");
  assert.equal(await simulateSend(oldPatch, { keyFormat: "$1" }), undefined);
  assert.equal((await simulateSend(patchWhatsAppMediaIdSource(original), { keyFormat: "$1" })).id.$1, "fixture-message");
});

test("collection fallback returns only the exact generated outgoing key", async () => {
  const result = await simulateSend(patchWhatsAppMediaIdSource(original), { keyFormat: "", collectionFallback: true });
  assert.equal(result.id.id, "fixture-id");
  for (const mutate of [key => ({...key,id:"other"}), key => ({...key,remote:"other@g.us"}), key => ({...key,fromMe:false}), key => ({...key,participant:"other@lid"})]) {
    assert.equal(await simulateSend(patchWhatsAppMediaIdSource(original), { collectionFallback:true, candidates:value=>[{...value,id:mutate(value.id)}] }), undefined);
  }
  for (const candidates of [() => [], value => [value, value]]) {
    assert.equal(await simulateSend(patchWhatsAppMediaIdSource(original), {collectionFallback:true,candidates}), undefined);
  }
});

test("provider send rejection cannot become a successful media acknowledgment", async () => {
  await assert.rejects(simulateSend(patchWhatsAppMediaIdSource(original), {sendRejected:true}), /send_rejected/);
});

test("real dependency send builder reproduces the media-ID collision before the patch", async () => {
  await assert.rejects(simulateSend(original), /Data passed to getter/);
});

for (const group of [false, true]) for (const mime of ["application/pdf", "image/png", "text/plain", "text/csv"]) {
  test(`media-ID fix preserves message identity and upload fields: ${group ? "group" : "direct"} ${mime}`, async () => {
    const result = await simulateSend(patchWhatsAppMediaIdSource(original), { group, mime });
    assert.equal(result.id._serialized, "fixture-message");
    assert.equal(Object.hasOwn(result, "__x_id"), false);
    assert.equal(result.clientUrl, "fixture-upload"); assert.equal(result.uploadhash, "fixture-hash");
    assert.equal(result.streamingSidecar, "fixture-sidecar"); assert.equal(result.mediaHandle, "fixture-handle");
    assert.equal(result.mimetype, mime); assert.equal(result.caption, "fixture-caption");
  });
}

test("text sends retain their identity and body", async () => {
  const result = await simulateSend(patchWhatsAppMediaIdSource(original), { media: false });
  assert.equal(result.id._serialized, "fixture-message"); assert.equal(result.body, "fixture-text");
});

test("patch is idempotent and refuses unknown dependency source", () => {
  const patched = patchWhatsAppMediaIdSource(original);
  assert.equal(patchWhatsAppMediaIdSource(patched), patched);
  assert.throws(() => patchWhatsAppMediaIdSource(original + "\n"), /source_mismatch/);
});

test("installed dependency has the pinned media-ID repair", () => {
  assert.equal(require("whatsapp-web.js/package.json").version, "1.34.7");
  assert.equal(installed, patchWhatsAppMediaIdSource(installed));
});
