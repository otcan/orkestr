import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexAuthDoctor,
  codexAuthFixCommand,
  listCodexAuthFailedTurns,
  parseSinceMs,
  recordCodexAuthFailedTurn,
} from "../packages/core/src/codex-auth-alert.js";
import { recordCodexRuntimeAuthFailureSignal } from "../packages/core/src/codex-auth-health.js";
import { formatCodexAuthDoctor, retryFailedThreadsCommand } from "../apps/cli/src/codex-auth-command.js";

async function tempEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-auth-alert-"));
  return { ORKESTR_HOME: path.join(home, "orkestr"), HOME: home, ORKESTR_SERVICE_USER: "orkestr-svc" };
}

function capture() {
  let text = "";
  return { write(chunk) { text += chunk; }, text: () => text };
}

test("first auth-failed turn alerts the owner once per window with the fix and failed threads", async () => {
  const env = await tempEnv();
  const alerts = [];
  const recordWatcherAlert = async (input) => { alerts.push(input); return { ok: true }; };
  await recordCodexAuthFailedTurn({ thread: { id: "thread-a", name: "alpha" }, turnId: "turn-1", messageId: "msg-1", reason: "codex_refresh_token_invalid" }, env, { recordWatcherAlert });
  await recordCodexAuthFailedTurn({ thread: { id: "thread-b", name: "beta" }, turnId: "turn-2", reason: "codex_refresh_token_invalid" }, env, { recordWatcherAlert });
  await recordCodexAuthFailedTurn({ thread: { id: "thread-a", name: "alpha" }, turnId: "turn-1", reason: "codex_refresh_token_invalid" }, env, { recordWatcherAlert });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].mirrorToConnector, true);
  assert.equal(alerts[0].code, "codex_auth_failed");
  assert.match(alerts[0].message, /log in again: sudo -u orkestr-svc -H bash -lc 'cd ~ && codex login --device-auth'/);
  assert.match(alerts[0].message, /alpha \(thread-a\)/);
  assert.match(alerts[0].message, /orkestr threads retry-failed --since 2h/);
  const stored = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "codex-auth-failed-turns.json"), "utf8"));
  assert.equal(stored.turns.length, 2);
});

test("alert fires again after the window and turn signals from the client are recorded", async () => {
  const env = { ...(await tempEnv()), ORKESTR_CODEX_AUTH_ALERT_WINDOW_MS: "60000", ORKESTR_WATCHER_ALERTS: "0" };
  await recordCodexRuntimeAuthFailureSignal({
    thread: { id: "thread-c", name: "gamma" },
    error: "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    turnId: "turn-9",
    messageId: "msg-9",
  }, env);
  await recordCodexRuntimeAuthFailureSignal({ thread: { id: "thread-c" }, error: "stream disconnected: 503", turnId: "turn-10" }, env);
  const file = path.join(env.ORKESTR_HOME, "codex-auth-failed-turns.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(stored.turns.map((turn) => turn.turnId), ["turn-9"]);
  await fs.writeFile(file, JSON.stringify({ ...stored, alertedAt: new Date(Date.now() - 120_000).toISOString() }));
  const alerts = [];
  const result = await recordCodexAuthFailedTurn({ thread: { id: "thread-d" }, turnId: "turn-11" }, env, { recordWatcherAlert: async (input) => { alerts.push(input); return { ok: true }; } });
  assert.equal(result.alerted, true);
  assert.equal(alerts.length, 1);
});

test("failed turns resolve their input message and doctor reports state without token contents", async () => {
  const env = await tempEnv();
  const noAlert = { recordWatcherAlert: async () => ({ ok: true }) };
  await recordCodexAuthFailedTurn({ thread: { id: "thread-a" }, turnId: "turn-1", messageId: "msg-1" }, env, noAlert);
  await recordCodexAuthFailedTurn({ thread: { id: "thread-b" }, turnId: "turn-2" }, env, noAlert);
  const turns = await listCodexAuthFailedTurns({ sinceMs: parseSinceMs("2h") }, env, {
    getThreadMessage: async (_threadId, id) => ({ id, role: "user", state: "delivered", text: "deploy the fix" }),
    listThreadMessages: async () => [{ id: "msg-2", role: "user", codexTurnId: "turn-2", text: "check logs" }],
  });
  assert.deepEqual(turns.map((turn) => [turn.messageId, turn.text]), [["msg-1", "deploy the fix"], ["msg-2", "check logs"]]);
  const doctor = await codexAuthDoctor(env, { codexLoginStatus: async () => ({ connected: false, reason: "not_logged_in" }) });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.recentFailures, 2);
  assert.equal(doctor.fix, codexAuthFixCommand(env));
  assert.match(formatCodexAuthDoctor(doctor), /BROKEN[\s\S]*fix: log in again/);
  assert.equal(parseSinceMs("30m"), 1_800_000);
});

test("retry-failed re-sends failed inputs quoted, idempotently, and honors --dry-run", async () => {
  const turns = [
    { threadId: "thread-a", turnId: "turn-1", messageId: "msg-1", role: "user", state: "delivered", text: "deploy the fix\nnow" },
    { threadId: "thread-b", turnId: "turn-2", messageId: "msg-2", role: "user", state: "queued", text: "held input" },
    { threadId: "thread-c", turnId: "turn-3", messageId: null, role: null, text: null },
  ];
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const payload = url.includes("/failed-turns") ? { ok: true, turns } : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const ctx = (stdout) => ({ env: {}, baseUrl: "http://orkestr.test", fetchImpl, stdout, stderr: capture() });
  const dry = capture();
  assert.equal(await retryFailedThreadsCommand(["--since", "2h", "--dry-run"], ctx(dry)), 0);
  assert.match(dry.text(), /would retry thread-a/);
  assert.equal(seen.filter((item) => item.method === "POST").length, 0);
  const out = capture();
  assert.equal(await retryFailedThreadsCommand(["--since", "2h"], ctx(out)), 0);
  const posts = seen.filter((item) => item.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/threads\/thread-a\/input$/);
  assert.match(posts[0].body.text, /> deploy the fix\n> now/);
  assert.equal(posts[0].body.idempotencyKey, "codex-auth-retry:thread-a:msg-1");
  assert.match(out.text(), /skip thread-b turn turn-2: input is still queued/);
  assert.match(out.text(), /skip thread-c turn turn-3: input message not found/);
});
