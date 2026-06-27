import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyThreadAttachmentPath,
  classifyThreadAttachmentPathRedaction,
  extractThreadAttachmentPathCandidates,
  redactDeniedThreadAttachmentPaths,
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

test("thread attachment policy allows temp artifacts for admin-owned threads only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-attachment-admin-tmp-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const paths = dataPaths(env);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-screenshot-"));
  const screenshotPath = path.join(tmpDir, "portal-mobile.png");
  await fs.writeFile(screenshotPath, "png", "utf8");
  await fs.mkdir(paths.secrets, { recursive: true });
  const secretPath = path.join(paths.secrets, "token.txt");
  await fs.writeFile(secretPath, "secret", "utf8");
  const adminThread = { id: "admin-thread", ownerUserId: "admin" };
  const userThread = { id: "user-thread", ownerUserId: "alice" };

  assert.equal(classifyThreadAttachmentPath(screenshotPath, { thread: adminThread, env }).ok, true);
  assert.equal(classifyThreadAttachmentPath(screenshotPath, { thread: userThread, env }).ok, false);
  assert.equal(classifyThreadAttachmentPath(secretPath, { thread: adminThread, env }).ok, false);

  const resolved = await resolveThreadAttachments({
    thread: adminThread,
    text: `Screenshot: [mobile](${screenshotPath})`,
    env,
  });
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.attachments[0].filename, "portal-mobile.png");
  assert.equal(resolved.attachments[0].mimetype, "image/png");
});

test("thread attachment path extraction ignores registered slash commands", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-attachment-commands-"));
  const env = { ORKESTR_HOME: home };
  const workspace = path.join(home, "workspace");
  const filePath = path.join(workspace, "report.txt");
  const thread = { id: "command-thread", cwd: workspace };

  const candidates = extractThreadAttachmentPathCandidates({
    thread,
    text: `Reply /safe-reset or /now. Use /implement, /codex, /connect google, and /help. Real file: ${filePath}`,
    env,
  });

  assert.deepEqual(candidates.map((candidate) => candidate.raw), [filePath]);
});

test("thread attachment resolution ignores code references, app routes, and directory mentions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-attachment-references-"));
  const env = { ORKESTR_HOME: home };
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const filePath = path.join(workspace, "index.html");
  const missingImagePath = path.join(workspace, "missing-screenshot.png");
  await fs.writeFile(filePath, "<main></main>", "utf8");
  const thread = { id: "reference-thread", cwd: workspace };
  const text = [
    `Changed [index.html](${filePath}:120).`,
    `Workspace: ${workspace}`,
    "Routes: /api/leads and /api/events",
    `Missing screenshot: ${missingImagePath}`,
  ].join("\n");

  const candidates = extractThreadAttachmentPathCandidates({ thread, text, env });
  const lineReference = candidates.find((candidate) => candidate.raw === `${filePath}:120`);
  assert.equal(lineReference?.path, filePath);
  assert.equal(lineReference?.lineReference, true);
  assert.equal(candidates.some((candidate) => candidate.raw === "/api/leads"), false);

  const resolved = await resolveThreadAttachments({ thread, text, env });
  assert.deepEqual(resolved.attachments, []);
  assert.deepEqual(resolved.skipped, [{
    path: missingImagePath,
    raw: missingImagePath,
    reason: "attachment_path_missing",
  }]);
});

test("thread attachment path redaction is opt-in and role-aware", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-attachment-redaction-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const redactingEnv = { ...env, ORKESTR_REDACT_LOCAL_FILE_PATHS: "1" };
  const paths = dataPaths(env);
  const workspace = path.join(home, "workspace");
  const allowedPath = path.join(workspace, "public-report.txt");
  const secretPath = path.join(paths.secrets, "token.txt");
  const adminThread = { id: "admin-thread", cwd: workspace, ownerUserId: "admin" };
  const userThread = { id: "user-thread", cwd: workspace, ownerUserId: "alice" };
  const text = `Open ${allowedPath}; secret ${secretPath}; route /api/leads; reply /safe-reset, /codex, /connect google, or /help.`;

  assert.equal(classifyThreadAttachmentPathRedaction(allowedPath, { thread: adminThread, env }).category, "ordinary_allowed");
  assert.equal(classifyThreadAttachmentPathRedaction(secretPath, { thread: adminThread, env }).category, "sensitive_denied");

  const adminText = redactDeniedThreadAttachmentPaths(text, { thread: adminThread, env });
  assert.match(adminText, new RegExp(allowedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(adminText, new RegExp(secretPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(adminText, /route \/api\/leads/);
  assert.match(adminText, /reply \/safe-reset, \/codex, \/connect google, or \/help/);

  const userText = redactDeniedThreadAttachmentPaths(text, { thread: userThread, env });
  assert.match(userText, new RegExp(allowedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(userText, new RegExp(secretPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(userText, /route \/api\/leads/);
  assert.doesNotMatch(userText, /\[local file path omitted]/);

  const redactedAdminText = redactDeniedThreadAttachmentPaths(text, { thread: adminThread, env: redactingEnv });
  assert.match(redactedAdminText, new RegExp(allowedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(redactedAdminText, new RegExp(secretPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(redactedAdminText, /route \/api\/leads/);
  assert.match(redactedAdminText, /reply \/safe-reset, \/codex, \/connect google, or \/help/);

  const redactedUserText = redactDeniedThreadAttachmentPaths(text, { thread: userThread, env: redactingEnv });
  assert.doesNotMatch(redactedUserText, new RegExp(allowedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(redactedUserText, new RegExp(secretPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(redactedUserText, /route \/api\/leads/);
  assert.match(redactedUserText, /reply \/safe-reset, \/codex, \/connect google, or \/help/);
  assert.equal((redactedUserText.match(/\[local file path omitted]/g) || []).length, 2);
});
