import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isMainModule } from "./main-module.mjs";

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

// Pinned compatibility repair for wwebjs/whatsapp-web.js#201922 and #201923.
// Preserve all upload fields; only remove the colliding private model ID.
export function patchWhatsAppMediaIdSource(source) {
  const original = source.replace(mediaIdPatch, "").replace(messageLookupPatch, originalMessageLookup);
  if (createHash("sha256").update(original).digest("hex") !== upstreamSha256) {
    throw Error("whatsapp_media_id_patch_source_mismatch: review the dependency before deployment");
  }
  return original.replace(anchor, mediaIdPatch + anchor).replace(originalMessageLookup, messageLookupPatch);
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
  console.log(`WhatsApp media-ID compatibility verified (${result.version}, ${result.patched ? "patched" : "already patched"}).`);
}
