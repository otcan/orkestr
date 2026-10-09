import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";

// Synthetic values only; the API is faked.

const TOKEN = "ovt_synthetic-fill-cli-token";
const env = { ORKESTR_DISABLE_CLI_AUTH: "1", ORKESTR_ENV_FILE: "", ORKESTR_VAULT_THREAD_TOKEN: TOKEN };

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

async function run(argv, payload = { status: "filled" }) {
  const stdout = capture();
  const stderr = capture();
  const seen = [];
  const fetchImpl = async (target, options = {}) => {
    seen.push({ url: String(target), method: options.method, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const code = await runCli(argv, { env, stdout, stderr, fetchImpl, cwd: "/tmp/example-workspace" });
  return { code, stdout: stdout.text(), stderr: stderr.text(), seen };
}

test("vault fill posts item and desktop with the thread token and prints only the status", async () => {
  const result = await run(["vault", "fill", "Example Login", "--desktop", "example-desk", "--field", "both", "--submit"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "filled\n");
  assert.equal(result.seen.length, 1);
  const [call] = result.seen;
  assert.match(call.url, /\/api\/vault\/agent\/fill$/);
  assert.equal(call.headers["x-orkestr-thread-token"], TOKEN);
  assert.deepEqual(call.body, { threadId: "", item: "Example Login", desktop: "example-desk", field: "both", submit: true });
});

test("vault fill reports failures and rejects bad usage and value flags", async () => {
  const failed = await run(["vault", "fill", "Example Login", "--desktop=example-desk", "--json"], { status: "failed", reason: "focus_not_password_field" });
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "{\"status\":\"failed\",\"reason\":\"focus_not_password_field\"}\n");
  const plain = await run(["vault", "fill", "Example Login", "--desktop", "example-desk"], { status: "failed", reason: "focus_unverifiable" });
  assert.equal(plain.stdout, "failed (focus_unverifiable)\n");
  assert.equal(failed.seen[0].body.field, "password");
  const missingDesktop = await run(["vault", "fill", "Example Login"]);
  assert.notEqual(missingDesktop.code, 0);
  assert.equal(missingDesktop.seen.length, 0);
  const valueFlag = await run(["vault", "fill", "Example Login", "--desktop", "example-desk", "--password=x"]);
  assert.notEqual(valueFlag.code, 0);
  assert.match(valueFlag.stderr, /vault_value_flag_disabled/);
});
