import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveGoogleWorkspaceConnectionToken } from "../packages/connectors/src/google-workspace-connections.js";
import { runTenantApiAgentGoogleWorkspaceTool } from "../packages/connectors/src/google-workspace-api-agent-tools.js";
import { runTenantApiAgentTool } from "../packages/core/src/tenant-api-agent-tools.js";
import { getGmailDraftApprovalSnapshot } from "../packages/connectors/src/gmail-draft-approval.js";
import { clearGmailSendApprovalsForConnection, consumeGmailSendApproval, decideGmailSendApproval, listGmailSendApprovals, requestGmailSendApproval } from "../packages/connectors/src/gmail-send-approvals.js";

test("agent Gmail sends require a reviewed exact payload and consume approval once", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-send-approval-")) };
  const principal = { userId: "alice", role: "user" };
  await saveGoogleWorkspaceConnectionToken({
    account: "alice@example.test",
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    capabilities: ["gmail_send"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }, env, { principal, setAsMain: true });
  const args = {
    accountId: "", account: "", to: "friend@example.test", cc: "", bcc: "",
    subject: "Hello", body: "A reviewed message", approvalRequestId: "",
  };
  let sent = 0;
  const context = {
    principal,
    threadId: "thread-1",
    fetchImpl: async (url, options) => {
      assert.match(String(url), /\/messages\/send$/);
      assert.equal(options.method, "POST");
      const raw = Buffer.from(JSON.parse(options.body).raw, "base64url").toString("utf8");
      assert.equal(raw, "To: friend@example.test\r\nSubject: Hello\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nA reviewed message");
      sent += 1;
      return { ok: true, status: 200, async json() { return { id: "sent-1" }; } };
    },
  };
  const run = (input, selectedContext = context) => runTenantApiAgentGoogleWorkspaceTool(
    "orkestr_send_gmail_message", input, selectedContext, env);
  const pending = await run(args);
  assert.equal(pending.result.error, "gmail_send_approval_required");
  assert.equal(sent, 0);
  const requestId = pending.result.requestId;
  const listed = await listGmailSendApprovals(principal, env);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].details.body, args.body);
  const storedPath = path.join(env.ORKESTR_HOME, "users", "alice", "secrets", "gmail-send-approvals.json");
  assert.equal((await fs.stat(storedPath)).mode & 0o777, 0o600);

  await assert.rejects(() => run({ ...args, approvalRequestId: requestId }), /gmail_send_approval_pending/);
  await assert.rejects(() => run({ ...args, body: "Altered", approvalRequestId: requestId }), /gmail_send_approval_mismatch/);
  await assert.rejects(() => run({ ...args, to: "other@example.test", approvalRequestId: requestId }), /gmail_send_approval_mismatch/);
  await assert.rejects(() => run({ ...args, cc: "hidden@example.test", approvalRequestId: requestId }), /gmail_send_approval_mismatch/);
  await assert.rejects(() => run({ ...args, bcc: "hidden@example.test", approvalRequestId: requestId }), /gmail_send_approval_mismatch/);
  await assert.rejects(() => run({ ...args, subject: "Altered", approvalRequestId: requestId }), /gmail_send_approval_mismatch/);
  await assert.rejects(() => decideGmailSendApproval(requestId, true, { userId: "bob" }, env), /gmail_send_approval_not_found/);
  assert.equal(sent, 0);

  await decideGmailSendApproval(requestId, true, principal, env);
  const completed = await run({ ...args, approvalRequestId: requestId });
  assert.equal(completed.result.ok, true);
  assert.equal(sent, 1);
  await assert.rejects(() => run({ ...args, approvalRequestId: requestId }), /gmail_send_approval_not_found/);
  assert.equal(sent, 1);
  assert.equal((await listGmailSendApprovals(principal, env)).length, 0);
});

test("approved Gmail send rejects extra serialized headers before provider delivery", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-header-tamper-")) };
  const principal = { userId: "alice", role: "user" };
  await saveGoogleWorkspaceConnectionToken({ account: "alice@example.test", accessToken: "fake", refreshToken: "fake", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"], capabilities: ["gmail_send"], expiresAt: Math.floor(Date.now() / 1000) + 3600 }, env, { principal, setAsMain: true });
  let sent = 0;
  const context = { principal, threadId: "thread-1", fetchImpl: async () => { sent++; return { ok: true, status: 200, async json() { return { id: "sent" }; } }; } };
  const args = { accountId: "", account: "", to: "friend@example.test", cc: "", bcc: "", subject: "Hello", body: "Reviewed", approvalRequestId: "" };
  const pending = await runTenantApiAgentGoogleWorkspaceTool("orkestr_send_gmail_message", args, context, env);
  await decideGmailSendApproval(pending.result.requestId, true, principal, env);
  await assert.rejects(() => runTenantApiAgentGoogleWorkspaceTool("orkestr_send_gmail_message", { ...args, from: "other@example.test", approvalRequestId: pending.result.requestId }, context, env), /gmail_send_approval_mismatch|gmail_send_unsupported_field/);
  assert.equal(sent, 0);
});

async function genericGmailSendFixture() {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-action-tamper-")) };
  const principal = { userId: "alice", role: "user" };
  await saveGoogleWorkspaceConnectionToken({ account: "alice@example.test", accessToken: "fake", refreshToken: "fake", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"], capabilities: ["gmail_send"], expiresAt: Math.floor(Date.now() / 1000) + 3600 }, env, { principal, setAsMain: true });
  const attachment = path.join(env.ORKESTR_HOME, "fake.txt");
  await fs.writeFile(attachment, "first", "utf8");
  let sent = 0;
  const context = { principal, thread: { id: "thread-1" }, fetchImpl: async () => { sent++; return { ok: true, status: 200, async json() { return { id: "sent" }; } }; } };
  const base = { accountId: "", account: "", to: "friend@example.test", cc: "", bcc: "", subject: "Hello", body: "", approvalRequestId: "" };
  const run = (parameters) => runTenantApiAgentTool("orkestr_run_action", { actionKey: "gmail.send.message", parameters }, context, env);
  return { env, principal, attachment, base, run, sent: () => sent };
}

test("generic action Gmail send rejects text fallback change after approval", async () => {
  const { env, principal, base, run, sent } = await genericGmailSendFixture();
  const pending = await run(base);
  await decideGmailSendApproval(pending.result.requestId, true, principal, env);
  await assert.rejects(() => run({ ...base, text: "Changed fallback", approvalRequestId: pending.result.requestId }), /gmail_send_approval_mismatch|gmail_send_unsupported_field/);
  await assert.rejects(() => run({ ...base, text: "Unreviewed fallback" }), /gmail_send_unsupported_field/);
  assert.equal(sent(), 0);
});

test("generic action Gmail send rejects attachment added after approval", async () => {
  const { env, principal, attachment, base, run, sent } = await genericGmailSendFixture();
  const pending = await run({ ...base, body: "Reviewed" });
  await decideGmailSendApproval(pending.result.requestId, true, principal, env);
  await assert.rejects(() => run({ ...base, body: "Reviewed", attachments: [{ path: attachment }], approvalRequestId: pending.result.requestId }), /gmail_send_approval_mismatch|gmail_send_unsupported_field/);
  await fs.writeFile(attachment, "changed after approval", "utf8");
  await assert.rejects(() => run({ ...base, body: "Reviewed", attachments: [{ path: attachment }], approvalRequestId: pending.result.requestId }), /gmail_send_approval_mismatch|gmail_send_unsupported_field/);
  assert.equal(sent(), 0);
});

test("generic action Gmail send rejects an attachment before approval", async () => {
  const { attachment, base, run, sent } = await genericGmailSendFixture();
  await assert.rejects(() => run({ ...base, body: "Reviewed", attachments: [{ path: attachment }] }), /gmail_send_unsupported_field/);
  assert.equal(sent(), 0);
});

async function draftHeaderFixture() {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-draft-header-")) };
  const principal = { userId: "alice", role: "user" };
  await saveGoogleWorkspaceConnectionToken({ account: "alice@example.test", accessToken: "fake", refreshToken: "fake", grantedScopes: ["https://www.googleapis.com/auth/gmail.compose"], capabilities: ["gmail_drafts"], expiresAt: Math.floor(Date.now() / 1000) + 3600 }, env, { principal, setAsMain: true });
  let source = "";
  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { id: "draft-1", message: { raw: Buffer.from(source).toString("base64url") } }; } });
  const options = { principal };
  return { setSource: (value) => { source = value; }, snapshot: () => getGmailDraftApprovalSnapshot("draft-1", env, fetchImpl, options) };
}

test("draft approval decodes UTF-8 B header before preview", async () => {
  const { setSource, snapshot } = await draftHeaderFixture();
  setSource("To: friend@example.test\r\nSubject: =?UTF-8?B?Q2Fmw6k=?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nBody");
  assert.equal((await snapshot()).details.subject, "Café");
});

test("draft approval decodes UTF-8 Q header before preview", async () => {
  const { setSource, snapshot } = await draftHeaderFixture();
  setSource("To: friend@example.test\r\nSubject: =?UTF-8?Q?Caf=C3=A9?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nBody");
  assert.equal((await snapshot()).details.subject, "Café");
});

test("draft approval refuses unknown body charset before preview", async () => {
  const { setSource, snapshot } = await draftHeaderFixture();
  setSource("To: friend@example.test\r\nSubject: Hello\r\nContent-Type: text/plain; charset=unknown-charset\r\n\r\nBody");
  await assert.rejects(() => snapshot(), /gmail_draft_approval_unsupported_charset/);
});

test("draft approval refuses unknown encoded-header charset before preview", async () => {
  const { setSource, snapshot } = await draftHeaderFixture();
  setSource("To: friend@example.test\r\nSubject: =?ISO-8859-1?Q?Caf=E9?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nBody");
  await assert.rejects(() => snapshot(), /gmail_draft_approval_unsupported_charset/);
});

test("draft approval preserves visible body whitespace", async () => {
  const { setSource, snapshot } = await draftHeaderFixture();
  setSource("To: friend@example.test\r\nSubject: Hello\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n  Indented body\r\n");
  assert.equal((await snapshot()).details.body, "  Indented body\r\n");
});

test("an approval cannot be reused after its connection grant changes", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-send-grant-version-")) };
  const principal = { userId: "alice" };
  const details = { to: "friend@example.test", subject: "Hello", body: "Content" };
  const original = { connectionId: "connection-1", grantUpdatedAt: "old-grant", threadId: "thread-1", details };
  const { requestId } = await requestGmailSendApproval(original, principal, env);
  await decideGmailSendApproval(requestId, true, principal, env);
  await assert.rejects(
    () => consumeGmailSendApproval(requestId, { ...original, grantUpdatedAt: "new-grant" }, principal, env),
    /gmail_send_approval_mismatch/,
  );
});

test("oversized email content is rejected before a review record is created", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-send-size-")) };
  const principal = { userId: "alice" };
  await assert.rejects(
    () => requestGmailSendApproval({ connectionId: "connection-1", details: { to: "friend@example.test", body: "x".repeat(60_001) } }, principal, env),
    /gmail_send_approval_content_too_large/,
  );
  assert.deepEqual(await listGmailSendApprovals(principal, env), []);
});

test("revoking one connection clears only its pending sends", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-send-revoke-")) };
  const principal = { userId: "alice" };
  const details = { to: "friend@example.test", body: "Content" };
  await requestGmailSendApproval({ connectionId: "connection-1", details }, principal, env);
  await requestGmailSendApproval({ connectionId: "connection-2", details }, principal, env);
  assert.deepEqual(await clearGmailSendApprovalsForConnection("connection-1", principal, env), { removed: 1 });
  assert.deepEqual((await listGmailSendApprovals(principal, env)).map((item) => item.connectionId), ["connection-2"]);
});

test("plain-text draft approval sends the reviewed raw MIME and rejects a changed draft", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-draft-approval-")) };
  const principal = { userId: "alice", role: "user" };
  await saveGoogleWorkspaceConnectionToken({
    account: "alice@example.test",
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.compose"],
    capabilities: ["gmail_send", "gmail_drafts"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }, env, { principal, setAsMain: true });
  const mime = (body) => Buffer.from(`To: friend@example.test\r\nSubject: Hello\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`, "utf8").toString("base64url");
  let raw = mime("Original body");
  let sent = 0;
  const context = {
    principal, threadId: "thread-1",
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/drafts/draft-1?format=raw")) {
        return { ok: true, status: 200, async json() { return { id: "draft-1", message: { raw } }; } };
      }
      assert.match(String(url), /\/drafts\/send$/);
      const payload = JSON.parse(options.body);
      assert.equal(payload.id, "draft-1");
      assert.equal(payload.message.raw, mime("Original body"));
      sent += 1;
      return { ok: true, status: 200, async json() { return { id: "sent-draft-1" }; } };
    },
  };
  const run = (approvalRequestId = "") => runTenantApiAgentGoogleWorkspaceTool(
    "orkestr_send_gmail_draft", { accountId: "", account: "", draftId: "draft-1", approvalRequestId }, context, env);
  const pending = await run();
  assert.equal(pending.result.error, "gmail_send_approval_required");
  const requestId = pending.result.requestId;
  const [preview] = await listGmailSendApprovals(principal, env);
  assert.equal(preview.kind, "draft");
  assert.equal(preview.details.body, "Original body");
  assert.equal(JSON.stringify(preview).includes(raw), false);
  await decideGmailSendApproval(requestId, true, principal, env);

  raw = mime("Changed body");
  await assert.rejects(() => run(requestId), /gmail_send_approval_mismatch/);
  assert.equal(sent, 0);
  raw = mime("Original body");
  const completed = await run(requestId);
  assert.equal(completed.result.ok, true);
  assert.equal(sent, 1);
  await assert.rejects(() => run(requestId), /gmail_send_approval_not_found/);
});

test("complex MIME drafts are rejected before an approval request", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-mime-reject-")) };
  const principal = { userId: "alice", role: "user" };
  await saveGoogleWorkspaceConnectionToken({
    account: "alice@example.test", accessToken: "fake-access", refreshToken: "fake-refresh",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.compose"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }, env, { principal, setAsMain: true });
  const raw = Buffer.from("To: friend@example.test\r\nSubject: Hello\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x--", "utf8").toString("base64url");
  await assert.rejects(() => runTenantApiAgentGoogleWorkspaceTool("orkestr_send_gmail_draft", {
    accountId: "", account: "", draftId: "draft-1", approvalRequestId: "",
  }, {
    principal,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { id: "draft-1", message: { raw } }; } }),
  }, env), /gmail_draft_approval_unsupported_mime/);
  assert.deepEqual(await listGmailSendApprovals(principal, env), []);
});
