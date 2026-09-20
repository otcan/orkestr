import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataPaths } from "./paths.js";
import { withStorageFileLock } from "./storage-lock.js";

const hash = value => createHash("sha256").update(value).digest("hex");

// A history writer may have read an old message before retention ran. Restore
// the exact quarantined journal before publishing that reference again. Never
// manufacture a missing journal or depend on a now-deleted producer artifact.
export async function fenceStagingReferences(threadId, messages, env) {
  if (env.ORKESTR_STAGING_RETENTION_FENCED !== "1") return;
  for (const message of messages) {
    const id = message?.outboundAttachmentStaging?.id;
    if (!id) continue;
    const owner = message.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin";
    if (!/^stg_[a-f0-9]{64}$/.test(id)) throw new Error("staging_reference_invalid");
    const dir = path.join(dataPaths(env).home, "outbound-attachment-staging", hash(`${owner}\n${threadId}`));
    const file = path.join(dir, `${id}.json`);
    await withStorageFileLock(file, async () => {
      const live = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (live) {
        if (!live.isFile() || live.isSymbolicLink()) throw new Error("staging_reference_invalid");
        return;
      }
      if (await fs.realpath(dir) !== path.resolve(dir)) throw new Error("staging_reference_invalid");
      const retained = path.join(dir, "retained", `${id}.json`);
      if (await fs.realpath(path.dirname(retained)) !== path.dirname(retained)) throw new Error("staging_reference_invalid");
      const handle = await fs.open(retained, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("staging_reference_invalid");
        const intent = JSON.parse(await handle.readFile("utf8"));
        if (intent.version !== 1 || intent.id !== id || intent.ownerUserId !== owner || intent.threadId !== threadId ||
            intent.messageId !== message.id || intent.textHash !== hash(message.text || "") || intent.state !== "ready") {
          throw new Error("staging_reference_binding_mismatch");
        }
        await fs.link(retained, file);
        const parent = await fs.open(dir, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await handle.close(); }
    });
  }
}
