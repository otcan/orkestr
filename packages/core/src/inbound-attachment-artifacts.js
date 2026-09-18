import fsp from "node:fs/promises";
import path from "node:path";
import { incrementCounter } from "./observability.js";
import { dataPaths } from "../../storage/src/paths.js";
import { inboundAttachmentQuarantineRoot } from "./inbound-attachment-files.js";

function pathInside(root, target) {
  const base = path.resolve(root);
  return path.resolve(target).startsWith(`${base}${path.sep}`);
}

export async function removeOwnedInboundAttachmentArtifact(target, root) {
  if (!target || !pathInside(root, target)) return false;
  try {
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    incrementCounter("orkestr_draft_attachment_cleanup_total", { outcome: "failed" });
    return false;
  }
}

export async function removeInboundAttachmentArtifacts(paths, env) {
  const quarantine = inboundAttachmentQuarantineRoot(env);
  const uploads = path.join(dataPaths(env).home, "uploads");
  let removed = 0;
  for (const target of paths) {
    if (await removeOwnedInboundAttachmentArtifact(target, quarantine) || await removeOwnedInboundAttachmentArtifact(target, uploads)) removed += 1;
  }
  return removed;
}
