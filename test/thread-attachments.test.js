import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyThreadAttachmentPath,
  resolveThreadAttachments,
} from "../packages/core/src/thread-attachments.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { dataPaths } from "../packages/storage/src/paths.js";

test("thread attachment extraction normalizes allowed paths and dedupes text and explicit attachments", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-attachments-"));
  const env = { ORKESTR_HOME: home };
  const paths = dataPaths(env);
  const uploadDir = path.join(paths.home, "uploads", "attachment-thread");
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, "report.txt");
  await fs.writeFile(filePath, "report body", "utf8");
  const thread = await createThread({ id: "attachment-thread", name: "Attachment Thread" }, env);

  const message = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-rollout",
    text: `Report: [report](${filePath})\nPlain path: ${filePath}`,
    attachments: [{ path: filePath, filename: "report.txt", mimetype: "text/plain" }],
  }, env);
  const stored = (await listThreadMessages(thread.id, env)).find((item) => item.id === message.id);

  assert.equal(stored.attachments.length, 1);
  assert.match(stored.attachments[0].id, /^att_[a-f0-9]{32}$/);
  assert.equal(stored.attachments[0].filename, "report.txt");
  assert.equal(stored.attachments[0].mimetype, "text/plain");
  assert.equal(stored.attachments[0].size, "report body".length);
});

test("thread attachment policy denies secrets and arbitrary paths by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-attachment-policy-"));
  const env = { ORKESTR_HOME: home };
  const paths = dataPaths(env);
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "public.txt"), "public", "utf8");
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "token.txt"), "secret", "utf8");
  const thread = { id: "policy-thread", cwd: workspace };

  assert.equal(classifyThreadAttachmentPath(path.join(workspace, "public.txt"), { thread, env }).ok, true);
  assert.equal(classifyThreadAttachmentPath(path.join(paths.secrets, "token.txt"), { thread, env }).ok, false);
  assert.equal(classifyThreadAttachmentPath("/etc/passwd", { thread, env }).ok, false);

  const resolved = await resolveThreadAttachments({
    thread,
    text: `${path.join(workspace, "public.txt")}\n${path.join(paths.secrets, "token.txt")}`,
    env,
  });
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.skipped.some((item) => item.reason === "attachment_path_forbidden"), true);
});
