import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { browserStoreInboundMedia } from "../packages/connectors/src/whatsapp-inbound-media-browser.js";
import {
  decryptWhatsAppMedia,
  expandWhatsAppMediaKey,
  selfDecryptWhatsAppMedia,
  whatsappMediaUrl,
} from "../packages/connectors/src/whatsapp-media-self-decrypt.js";

// Builds an encrypted payload exactly the way WhatsApp media is encrypted.
function encryptFixture(plain, type = "image") {
  const mediaKey = crypto.randomBytes(32);
  const { iv, cipherKey, macKey } = expandWhatsAppMediaKey(mediaKey, type);
  const cipher = crypto.createCipheriv("aes-256-cbc", cipherKey, iv);
  const file = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac("sha256", macKey).update(iv).update(file).digest().subarray(0, 10);
  const encrypted = Buffer.concat([file, mac]);
  return {
    encrypted,
    keys: {
      directPath: "/v/t62.7118-24/fixture.enc?ccb=11-4",
      mediaKey: mediaKey.toString("base64"),
      type,
      mimetype: "image/heic",
      filename: "",
      encFilehash: crypto.createHash("sha256").update(encrypted).digest("base64"),
      filehash: crypto.createHash("sha256").update(plain).digest("base64"),
    },
  };
}

test("decrypts WhatsApp media and verifies enc hash, MAC and file hash", () => {
  const plain = crypto.randomBytes(4096);
  const { encrypted, keys } = encryptFixture(plain);
  assert.deepEqual(decryptWhatsAppMedia(encrypted, keys), plain);

  const tampered = Buffer.from(encrypted);
  tampered[5] ^= 0xff;
  assert.throws(() => decryptWhatsAppMedia(tampered, { ...keys, encFilehash: "" }), /whatsapp_media_mac_mismatch/);
  assert.throws(() => decryptWhatsAppMedia(tampered, keys), /whatsapp_media_enc_hash_mismatch/);
  assert.throws(() => decryptWhatsAppMedia(encrypted, { ...keys, filehash: crypto.createHash("sha256").update("x").digest("base64") }), /whatsapp_media_file_hash_mismatch/);
  assert.throws(() => decryptWhatsAppMedia(encrypted, { ...keys, type: "unknown" }), /whatsapp_media_type_unsupported/);
  assert.throws(() => whatsappMediaUrl("https://elsewhere.example/x"), /whatsapp_media_direct_path_invalid/);
});

test("self-decrypt downloads from the WhatsApp media host and returns MessageMedia-shaped data", async () => {
  const plain = crypto.randomBytes(1000);
  const { encrypted, keys } = encryptFixture(plain);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.length) };
  };
  const media = await selfDecryptWhatsAppMedia(keys, { fetchImpl });
  assert.deepEqual(urls, ["https://mmg.whatsapp.net/v/t62.7118-24/fixture.enc?ccb=11-4"]);
  assert.equal(Buffer.from(media.data, "base64").equals(plain), true);
  assert.equal(media.mimetype, "image/heic");
  assert.equal(media.selfDecrypted, true);
  await assert.rejects(selfDecryptWhatsAppMedia(keys, { fetchImpl: async () => ({ ok: false, status: 404 }) }), /whatsapp_media_fetch_failed/);
});

test("browser store fallback self-decrypts InvalidMediaFileType rejections without leaking keys", async () => {
  const plain = crypto.randomBytes(512);
  const { keys } = encryptFixture(plain);
  const rejection = {
    error: { name: "InvalidMediaFileType", constructorName: "t", message: "Unexpected mimetype application/octet-stream for media type image" },
    media: { found: true, type: "image", mimetype: "image/heic" },
    selfDecrypt: keys,
  };
  const client = { pupPage: { evaluate: async () => structuredClone(rejection) } };
  const seen = [];
  const media = await browserStoreInboundMedia({
    client,
    eventId: "EVENT1",
    chatId: "123@g.us",
    onMedia: (value) => seen.push(value),
    selfDecrypt: async (received) => {
      assert.equal(received.mediaKey, keys.mediaKey);
      return { data: plain.toString("base64"), mimetype: received.mimetype, filename: "", filesize: plain.length, selfDecrypted: true };
    },
  });
  assert.equal(media.selfDecrypted, true);
  assert.equal(JSON.stringify(seen).includes(keys.mediaKey), false);
  assert.equal(JSON.stringify(seen).includes(keys.directPath), false);

  // A failed self-decrypt surfaces the original, readable WhatsApp Web error.
  await assert.rejects(browserStoreInboundMedia({
    client,
    eventId: "EVENT1",
    selfDecrypt: async () => { throw Object.assign(new Error("whatsapp_media_mac_mismatch"), { code: "whatsapp_media_mac_mismatch" }); },
  }), (error) => /Unexpected mimetype/.test(error.message) && error.selfDecryptError === "whatsapp_media_mac_mismatch");

  // Other browser errors are unchanged: no self-decrypt attempt.
  let called = false;
  const other = { pupPage: { evaluate: async () => ({ error: { name: "TypeError", message: "x" }, media: { found: true } }) } };
  await assert.rejects(browserStoreInboundMedia({ client: other, eventId: "EVENT2", selfDecrypt: async () => { called = true; } }));
  assert.equal(called, false);
});
