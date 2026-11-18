import test from "node:test";
import assert from "node:assert/strict";
import { cancelPageDialog } from "../packages/browsers/src/cdp-dialog-recovery.js";

test("only cancellation is sent, without evaluation, acceptance, or prompt text", async () => {
  const calls = [];
  assert.deepEqual(await cancelPageDialog(async (...args) => { calls.push(args); }), { cancelled: true });
  assert.deepEqual(calls, [["Page.handleJavaScriptDialog", { accept: false }]]);
});

test("no-dialog is harmless, other errors remain failures", async () => {
  const missing = Object.assign(new Error("No dialog is showing"), { code: -32602 });
  assert.deepEqual(await cancelPageDialog(async () => { throw missing; }), { cancelled: false, reason: "no_dialog" });
  const lost = new Error("connection lost");
  await assert.rejects(cancelPageDialog(async () => { throw lost; }), error => error === lost);
});

test("requires an existing caller-owned CDP transport", async () => {
  await assert.rejects(cancelPageDialog(null), /dialog_send_required/);
});
