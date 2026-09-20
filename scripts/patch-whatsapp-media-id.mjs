import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isMainModule } from "./main-module.mjs";

const upstreamSha256 = "0d0f88565f481dbfeb9493b04b24033a2cb60f5fd2fd0e84e543b461d98878fe";
const anchor = "        // Bot's won't reply if canonicalUrl is set (linking)";
export const mediaIdPatch = "        // Orkestr: prevent MediaData private ID from replacing the outgoing MsgKey.\n        delete message.__x_id;\n\n";

// Pinned compatibility repair for wwebjs/whatsapp-web.js#201922 and #201923.
// Preserve all upload fields; only remove the colliding private model ID.
export function patchWhatsAppMediaIdSource(source) {
  const original = source.includes(mediaIdPatch) ? source.replace(mediaIdPatch, "") : source;
  if (createHash("sha256").update(original).digest("hex") !== upstreamSha256) {
    throw Error("whatsapp_media_id_patch_source_mismatch: review the dependency before deployment");
  }
  return original.replace(anchor, mediaIdPatch + anchor);
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
