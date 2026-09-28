// Node-side download + decryption of WhatsApp media.
//
// WhatsApp Web's downloadAndMaybeDecrypt downloads and decrypts media, then
// rejects files whose sniffed content type does not match the declared media
// type (`InvalidMediaFileType`, e.g. "Unexpected mimetype
// application/octet-stream for media type image" for formats its browser-side
// sniffer does not know). The bytes themselves are valid, so Orkestr fetches
// the encrypted file and decrypts it with the standard WhatsApp media scheme
// instead, verifying the encrypted-file hash, the MAC and the plaintext hash.
// Media keys are secrets: they are only held in memory and never logged.
import crypto from "node:crypto";

const MEDIA_HOST = "https://mmg.whatsapp.net";
const KEY_INFO = {
  image: "WhatsApp Image Keys",
  sticker: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  gif: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  ptt: "WhatsApp Audio Keys",
  document: "WhatsApp Document Keys",
};
const MAC_LENGTH = 10;

function selfDecryptError(code, detail = {}) {
  return Object.assign(new Error(code), { code, ...detail });
}

function base64Bytes(value) {
  const text = String(value || "").trim();
  return text ? Buffer.from(text, "base64") : Buffer.alloc(0);
}

export function whatsappMediaKeyInfo(type = "") {
  return KEY_INFO[String(type || "").toLowerCase()] || "";
}

export function expandWhatsAppMediaKey(mediaKey, type) {
  const info = whatsappMediaKeyInfo(type);
  if (!info) throw selfDecryptError("whatsapp_media_type_unsupported", { mediaType: String(type || "") });
  const key = Buffer.isBuffer(mediaKey) ? mediaKey : base64Bytes(mediaKey);
  if (key.length !== 32) throw selfDecryptError("whatsapp_media_key_invalid");
  const expanded = Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(32), Buffer.from(info), 112));
  return { iv: expanded.subarray(0, 16), cipherKey: expanded.subarray(16, 48), macKey: expanded.subarray(48, 80) };
}

// Pure: verifies and decrypts an encrypted WhatsApp media payload.
export function decryptWhatsAppMedia(encrypted, { mediaKey, type, encFilehash = "", filehash = "" } = {}) {
  const payload = Buffer.from(encrypted);
  if (payload.length <= MAC_LENGTH) throw selfDecryptError("whatsapp_media_payload_too_short");
  if (encFilehash) {
    const actual = crypto.createHash("sha256").update(payload).digest("base64");
    if (actual !== String(encFilehash)) throw selfDecryptError("whatsapp_media_enc_hash_mismatch");
  }
  const { iv, cipherKey, macKey } = expandWhatsAppMediaKey(mediaKey, type);
  const file = payload.subarray(0, payload.length - MAC_LENGTH);
  const mac = payload.subarray(payload.length - MAC_LENGTH);
  const expectedMac = crypto.createHmac("sha256", macKey).update(iv).update(file).digest().subarray(0, MAC_LENGTH);
  if (!crypto.timingSafeEqual(mac, expectedMac)) throw selfDecryptError("whatsapp_media_mac_mismatch");
  const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
  const plain = Buffer.concat([decipher.update(file), decipher.final()]);
  if (filehash) {
    const actual = crypto.createHash("sha256").update(plain).digest("base64");
    if (actual !== String(filehash)) throw selfDecryptError("whatsapp_media_file_hash_mismatch");
  }
  return plain;
}

export function whatsappMediaUrl(directPath = "") {
  const path = String(directPath || "").trim();
  if (!path.startsWith("/")) throw selfDecryptError("whatsapp_media_direct_path_invalid");
  return `${MEDIA_HOST}${path}`;
}

// Downloads and decrypts; returns the same shape as whatsapp-web.js MessageMedia
// data ({ data: base64, mimetype, filename, filesize }).
export async function selfDecryptWhatsAppMedia(keys = {}, { fetchImpl = globalThis.fetch, timeoutMs = 60_000, maxBytes = 100 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== "function") throw selfDecryptError("whatsapp_media_fetch_unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let encrypted;
  try {
    const response = await fetchImpl(whatsappMediaUrl(keys.directPath), { signal: controller.signal });
    if (!response?.ok) throw selfDecryptError("whatsapp_media_fetch_failed", { status: response?.status ?? null });
    encrypted = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  if (encrypted.length > maxBytes) throw selfDecryptError("whatsapp_media_too_large", { bytes: encrypted.length });
  const plain = decryptWhatsAppMedia(encrypted, keys);
  return {
    data: plain.toString("base64"),
    mimetype: String(keys.mimetype || "application/octet-stream"),
    filename: String(keys.filename || ""),
    filesize: plain.length,
    selfDecrypted: true,
  };
}
