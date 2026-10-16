import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isMainModule } from "./main-module.mjs";

// Reversible edits to the pinned whatsapp-web.js injected utility source.
// WhatsApp Web renamed some serialized IDs to $1 (wwebjs issue #201845).
// Keep native identities intact and expose the field expected by wwebjs models.
const initialization = "    window.WWebJS = {};";
const helpers = `${initialization}

    const orkestrSerializedId = value => typeof value === 'string' ? value
        : value?._serialized || value?.$1
            || (value?.user && value?.server ? value.user + '@' + value.server : '');
    const orkestrIdModel = value => {
        const serialized = orkestrSerializedId(value);
        return value && typeof value === 'object' && serialized
            ? { ...value, _serialized: serialized } : value;
    };`;

const lastMessageStart = "            const lastMessage = chat.lastReceivedKey\n";
const chatLookup = "                window.require('WAWebCollections').Chat.get(chatWid) ||";
const alternateLookup = `${chatLookup}
                (() => {
                    // Only use WhatsApp's own cached PN/LID mapping, never infer an alias.
                    try {
                        const alternate = window.require('WAWebApiContact').getAlternateUserWid(chatWid);
                        return alternate && window.require('WAWebCollections').Chat.get(alternate);
                    } catch { return undefined; }
                })() ||`;
const chatModel = "        const model = chat.serialize();";
const normalizedChatModel = `${chatModel}
        let canonicalId = model.id || chat.id;
        if (chat.id?.server === 'lid') {
            try {
                const phone = window.require('WAWebApiContact').getPhoneNumber(chat.id);
                if (phone?.server === 'c.us') canonicalId = phone;
            } catch { /* An unknown alias must retain its native ID. */ }
        }
        model.id = orkestrIdModel(canonicalId);`;

const edits = [
  [initialization, helpers],
  ["        const msg = message.serialize();", `        const msg = message.serialize();
        msg.id = orkestrIdModel(msg.id);
        for (const field of ['from', 'to', 'author']) {
            if (msg[field]) msg[field] = orkestrIdModel(msg[field]);
        }`],
  ["remote: msg.id.remote._serialized,", "remote: orkestrSerializedId(msg.id.remote),"],
  [chatLookup, alternateLookup],
  [chatModel, normalizedChatModel],
  [".createWid(chat.id._serialized);", ".createWid(orkestrSerializedId(chat.id));"],
  ["                p.id = toPn(p.id) ?? p.id;", "                p.id = orkestrIdModel(toPn(p.id) ?? p.id);"],
  [lastMessageStart, "            const lastMessageId = orkestrSerializedId(chat.lastReceivedKey);\n            const lastMessage = lastMessageId\n"],
  [".Msg.get(chat.lastReceivedKey._serialized)", ".Msg.get(lastMessageId)"],
  ["                              chat.lastReceivedKey._serialized,", "                              lastMessageId,"],
  ["        res.isBusiness =", "        res.id = orkestrIdModel(res.id);\n\n        res.isBusiness ="],
];

export function stripWhatsAppHistoryIdPatch(source) {
  for (const [before, after] of [...edits].reverse()) source = source.replace(after, before);
  return source;
}

export function applyWhatsAppHistoryIdPatch(source) {
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw Error("whatsapp_history_id_patch_anchor_mismatch");
    source = source.replace(before, after);
  }
  return source;
}

const upstreamSha256 = "0d0f88565f481dbfeb9493b04b24033a2cb60f5fd2fd0e84e543b461d98878fe";
const anchor = "        // Bot's won't reply if canonicalUrl is set (linking)";
export const mediaIdPatch = "        // Orkestr: prevent MediaData private ID from replacing the outgoing MsgKey.\n        delete message.__x_id;\n\n";
export const originalMessageLookup = "        return window\n            .require('WAWebCollections')\n            .Msg.get(newMsgKey._serialized);";
export const messageLookupPatch = `        // Orkestr: resolve only the exact generated key, including renamed key fields.
        const messages = window.require('WAWebCollections').Msg;
        const keyString = newMsgKey._serialized || newMsgKey.$1;
        const stored = keyString ? messages.get(keyString) : undefined;
        if (stored) return stored;
        const wid = value => typeof value === 'string' ? value
            : value?._serialized || value?.$1
                || (value?.user && value?.server ? value.user + '@' + value.server : '');
        const remote = wid(newMsgKey.remote);
        if (!newMsgKey.id || !remote || newMsgKey.fromMe !== true) return undefined;
        const matches = (messages.getModelsArray?.() || []).filter(candidate => {
            const key = candidate?.id;
            return key?.id === newMsgKey.id && key.fromMe === true
                && wid(key.remote) === remote
                && wid(key.participant) === wid(newMsgKey.participant);
        });
        return matches.length === 1 ? matches[0] : undefined;`;

// Pinned compatibility repairs for wwebjs/whatsapp-web.js#201922, #201923,
// and #201845. Normalize read IDs and preserve all media upload fields.
export function patchWhatsAppMediaIdSource(source) {
  const original = stripWhatsAppHistoryIdPatch(source).replace(mediaIdPatch, "").replace(messageLookupPatch, originalMessageLookup);
  if (createHash("sha256").update(original).digest("hex") !== upstreamSha256) {
    throw Error("whatsapp_media_id_patch_source_mismatch: review the dependency before deployment");
  }
  return applyWhatsAppHistoryIdPatch(original.replace(anchor, mediaIdPatch + anchor).replace(originalMessageLookup, messageLookupPatch));
}

export async function patchInstalledWhatsAppMediaId() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("whatsapp-web.js/package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.version !== "1.34.7") throw Error("whatsapp_media_id_patch_version_mismatch");
  const filePath = path.join(path.dirname(manifestPath), "src/util/Injected/Utils.js");
  const source = await fs.readFile(filePath, "utf8");
  const patched = patchWhatsAppMediaIdSource(source);
  if (patched !== source) await fs.writeFile(filePath, patched);
  return { version: manifest.version, patched: patched !== source };
}

if (isMainModule(import.meta.url)) {
  const result = await patchInstalledWhatsAppMediaId();
  console.log(`WhatsApp message-ID compatibility verified (${result.version}, ${result.patched ? "patched" : "already patched"}).`);
}
