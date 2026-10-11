import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { userDataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

const ttlMs = 15 * 60 * 1000;
const maxPending = 20;

function clean(value, max = 60_000) {
  return String(value ?? "").trim().slice(0, max);
}

function approvalError(code, statusCode = 403) {
  return Object.assign(new Error(code), { code, statusCode });
}

function principalId(principal = {}) {
  const id = clean(principal?.userId || principal?.id, 200);
  if (!id) throw approvalError("gmail_send_approval_user_required", 401);
  return id;
}

function filePath(principal, env) {
  return path.join(userDataPaths(principalId(principal), env).secrets, "gmail-send-approvals.json");
}

function normalizedDetails(input = {}, { preserveBody = false } = {}) {
  for (const [field, limit] of [["from", 4000], ["to", 4000], ["cc", 4000], ["bcc", 4000], ["subject", 1000], ["body", 60_000]]) {
    const value = String(input[field] ?? "");
    if ((field === "body" && preserveBody ? value : value.trim()).length > limit) throw approvalError("gmail_send_approval_content_too_large", 400);
  }
  const header = (value, max) => clean(value, max).replace(/\r?\n/g, " ");
  const details = {
    from: header(input.from, 4000),
    to: header(input.to, 4000),
    cc: header(input.cc, 4000),
    bcc: header(input.bcc, 4000),
    subject: header(input.subject, 1000),
    body: preserveBody ? String(input.body ?? "") : clean(input.body),
  };
  if (!details.to) throw approvalError("gmail_send_to_required", 400);
  return details;
}

function action({ connectionId = "", grantUpdatedAt = "", threadId = "", kind = "message", draftId = "", raw = "", details = {} } = {}) {
  const connection = clean(connectionId, 200);
  if (!connection) throw approvalError("gmail_send_connection_required", 400);
  if (!["message", "draft"].includes(kind)) throw approvalError("gmail_send_approval_kind_invalid", 400);
  const draft = kind === "draft" ? clean(draftId, 200) : "";
  const approvedRaw = clean(raw, 120_000);
  if (kind === "draft" && (!draft || !approvedRaw || clean(raw).length > 120_000)) {
    throw approvalError("gmail_send_approval_draft_required", 400);
  }
  if (raw && (!approvedRaw || clean(raw).length > 120_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(approvedRaw))) {
    throw approvalError("gmail_send_approval_raw_invalid", 400);
  }
  const rawSha256 = approvedRaw ? createHash("sha256").update(Buffer.from(approvedRaw, "base64url")).digest("hex") : "";
  return {
    connectionId: connection, grantUpdatedAt: clean(grantUpdatedAt, 100), threadId: clean(threadId, 200),
    kind, draftId: draft, raw: approvedRaw, rawSha256, details: normalizedDetails(details, { preserveBody: kind === "draft" }),
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function current(records, now = Date.now()) {
  return (Array.isArray(records) ? records : []).filter((item) =>
    Date.parse(item.expiresAt || 0) > now && !item.consumedAt && !item.rejectedAt);
}

export async function requestGmailSendApproval(input = {}, principal = {}, env = process.env) {
  const requested = action(input);
  const location = filePath(principal, env);
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  return withStorageFileLock(location, async () => {
    const now = Date.now();
    const records = current(await readJson(location, []), now);
    const hash = digest(requested);
    const existing = records.find((item) => item.hash === hash && !item.consumedAt && !item.rejectedAt);
    if (existing) return { requestId: existing.requestId, expiresAt: existing.expiresAt, approved: Boolean(existing.approvedAt) };
    if (records.filter((item) => !item.consumedAt && !item.rejectedAt).length >= maxPending) {
      throw approvalError("gmail_send_approval_limit", 429);
    }
    const record = {
      requestId: randomUUID(),
      ...requested,
      hash,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    await writeSecretJson(location, [...records, record]);
    return { requestId: record.requestId, expiresAt: record.expiresAt, approved: false };
  });
}

export async function listGmailSendApprovals(principal = {}, env = process.env) {
  const location = filePath(principal, env);
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  return withStorageFileLock(location, async () => {
    const saved = await readJson(location, []);
    const records = current(saved);
    if (saved.length !== records.length) await writeSecretJson(location, records);
    return records.map(({ requestId, connectionId, threadId, kind, draftId, details, createdAt, expiresAt, approvedAt }) => ({
      requestId, connectionId, threadId, kind, draftId, details, createdAt, expiresAt, approved: Boolean(approvedAt),
    }));
  });
}

export async function decideGmailSendApproval(requestId = "", approve = false, principal = {}, env = process.env) {
  const location = filePath(principal, env);
  return withStorageFileLock(location, async () => {
    const records = current(await readJson(location, []));
    const record = records.find((item) => item.requestId === clean(requestId, 100));
    if (!record || record.consumedAt || record.rejectedAt) throw approvalError("gmail_send_approval_not_found", 404);
    if (Date.parse(record.expiresAt) <= Date.now()) throw approvalError("gmail_send_approval_expired", 410);
    if (approve) record.approvedAt = new Date().toISOString();
    else record.rejectedAt = new Date().toISOString();
    await writeSecretJson(location, current(records));
    return { ok: true, requestId: record.requestId, approved: Boolean(record.approvedAt) };
  });
}

export async function consumeGmailSendApproval(requestId = "", input = {}, principal = {}, env = process.env) {
  const expectedHash = digest(action(input));
  const location = filePath(principal, env);
  return withStorageFileLock(location, async () => {
    const records = current(await readJson(location, []));
    const record = records.find((item) => item.requestId === clean(requestId, 100));
    if (!record || record.rejectedAt || record.consumedAt) throw approvalError("gmail_send_approval_not_found", 404);
    if (Date.parse(record.expiresAt) <= Date.now()) throw approvalError("gmail_send_approval_expired", 410);
    if (record.hash !== expectedHash) throw approvalError("gmail_send_approval_mismatch", 403);
    if (record.rawSha256 !== (record.raw ? createHash("sha256").update(Buffer.from(record.raw, "base64url")).digest("hex") : "")) {
      throw approvalError("gmail_send_approval_mismatch", 403);
    }
    if (!record.approvedAt) throw approvalError("gmail_send_approval_pending", 409);
    record.consumedAt = new Date().toISOString();
    await writeSecretJson(location, current(records));
    return { ok: true, requestId: record.requestId, raw: record.raw, draftId: record.draftId };
  });
}

export async function clearGmailSendApprovalsForConnection(connectionId = "", principal = {}, env = process.env) {
  const location = filePath(principal, env);
  const target = clean(connectionId, 200);
  return withStorageFileLock(location, async () => {
    const records = current(await readJson(location, []));
    const remaining = records.filter((item) => item.connectionId !== target);
    if (remaining.length !== records.length) await writeSecretJson(location, remaining);
    return { removed: records.length - remaining.length };
  });
}
