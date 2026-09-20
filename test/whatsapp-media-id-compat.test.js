import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { mediaIdPatch, patchWhatsAppMediaIdSource } from "../scripts/patch-whatsapp-media-id.mjs";

const require = createRequire(import.meta.url);
const installed = await fs.readFile(require.resolve("whatsapp-web.js/src/util/Injected/Utils.js"), "utf8");
const original = installed.replace(mediaIdPatch, "");

async function simulateSend(source, { media = true, group = false, mime = "application/pdf" } = {}) {
  let result;
  class MsgKey { constructor(fields) { Object.assign(this, fields, { _serialized: "fixture-message" }); } static async newId() { return "fixture-id"; } }
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
      result = message; return [Promise.resolve(message), Promise.resolve()];
    } },
    WAWebCollections: { Msg: { get: () => result } },
  };
  const context = vm.createContext({ exports: {}, window: { require(name) { assert.ok(modules[name], name); return modules[name]; } } });
  vm.runInContext(source, context); context.exports.LoadUtils();
  const mediaModel = { __x_id: undefined, clientUrl: "fixture-upload", uploadhash: "fixture-hash", streamingSidecar: "fixture-sidecar", mediaHandle: "fixture-handle", toJSON: () => ({ mimetype: mime, type: "document" }) };
  context.window.WWebJS.processMediaData = async () => mediaModel;
  const chat = { id: { isLid: () => false, isGroup: () => group, isStatus: () => false }, groupMetadata: { isLidAddressingMode: true } };
  return context.window.WWebJS.sendMessage(chat, "fixture-text", media ? { media: {}, caption: "fixture-caption", sendMediaAsDocument: !mime.startsWith("image/") } : {});
}

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
