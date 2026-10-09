import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE } from "../packages/core/src/claude-code-runtime-notices.js";

// Regression: an agent looked for an owner-granted credential with
// `orkestr secret list`, found nothing and reported the Vault as missing.
// Every place an agent is likely to look must point at `orkestr vault`.

const baseEnv = { ORKESTR_DISABLE_CLI_AUTH: "1", ORKESTR_ENV_FILE: "" };

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

async function secretList(argv) {
  const stdout = capture();
  const stderr = capture();
  const fetchImpl = async (target) => {
    const { pathname } = new URL(target);
    const payload = pathname === "/api/secure-input/secrets"
      ? { secrets: [{ name: "example_api_key", handle: "secret://user/example-user/example_api_key", scope: "user", configured: true }] }
      : { error: `missing route: ${pathname}` };
    return new Response(JSON.stringify(payload), { status: payload.error ? 404 : 200, headers: { "content-type": "application/json" } });
  };
  const code = await runCli(argv, { env: baseEnv, stdout, stderr, fetchImpl, cwd: "/tmp/example-workspace" });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

test("secret list points agents to the vault without breaking JSON output", async () => {
  const json = await secretList(["secret", "list", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.secrets.length, 1);
  assert.equal(payload.vault.command, "orkestr vault list");
  assert.equal(json.stderr, "");

  const text = await secretList(["secret", "list"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /example_api_key/);
  assert.doesNotMatch(text.stdout, /orkestr vault list/);
  assert.match(text.stderr, /granted to this thread are not listed here; run `orkestr vault list`/);
});

test("headless Claude Code runtime notice tells agents where thread credentials live", () => {
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /Orkestr Vault, not in `orkestr secret list`/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /orkestr vault exec <item> -- <command>/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /never print the values/);
});
