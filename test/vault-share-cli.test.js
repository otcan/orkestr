import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { decryptVaultShare } from "../packages/core/src/vault-share-crypto.js";

// Synthetic values only; the API is faked.

const env = { ORKESTR_DISABLE_CLI_AUTH: "1", ORKESTR_ENV_FILE: "", ORKESTR_VAULT_THREAD_TOKEN: "synthetic-thread-token" };
const PASSWORD = "synthetic-share-cli-password";
const base = "https://orkestr.example.com/s/e/SyntheticTokenSyntheticTokenSyntheticToken12";

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

async function run(argv, extra = {}) {
  const stdout = capture();
  const stderr = capture();
  const seen = [];
  const fetchImpl = async (target, options = {}) => {
    const key = `${String(options.method || "GET").toUpperCase()} ${new URL(target).pathname}`;
    seen.push({ key, target: String(target), raw: String(options.body || ""), headers: options.headers || {} });
    const payload = key === "POST /api/vault/agent/credentials"
      ? { itemId: "vi_1", password: PASSWORD }
      : { ok: true, url: base, link: { id: "sl_example", kind: "e2e", status: "active" } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const code = await runCli(argv, { env, stdout, stderr, fetchImpl, cwd: "/tmp/example-workspace", ...extra });
  return { code, stdout: stdout.text(), stderr: stderr.text(), seen };
}

test("vault share encrypts locally and keeps the key out of every request", async () => {
  const result = await run(["vault", "share", "Example", "--ttl", "1d", "--views", "2", "--label", "For a friend"]);
  assert.equal(result.code, 0, result.stderr);
  const [url, key] = result.stdout.trim().split("#");
  assert.equal(url, base);
  const create = result.seen.find((call) => call.key === "POST /api/secret-links/e2e");
  const body = JSON.parse(create.raw);
  assert.deepEqual({ ttl: body.ttl, views: body.views, label: body.label, name: body.name }, { ttl: "1d", views: 2, label: "For a friend", name: "Example" });
  assert.equal(create.headers["x-orkestr-thread-token"], "synthetic-thread-token");
  for (const call of result.seen.filter((item) => item.key !== "POST /api/vault/agent/credentials")) {
    assert.equal(call.raw.includes(PASSWORD), false);
    assert.equal(call.raw.includes(key) || call.target.includes(key), false);
  }
  assert.equal(decryptVaultShare(body.envelope, key), PASSWORD);
});

test("vault share --passphrase-prompt derives the key from a hidden passphrase", async () => {
  const short = await run(["vault", "share", "Example", "--passphrase-prompt"], { readPassphrase: async () => "short" });
  assert.equal(short.code, 1);
  assert.match(short.stderr, /vault_share_passphrase_too_short/);
  const result = await run(["vault", "share", "Example", "--passphrase-prompt"], { readPassphrase: async () => "example passphrase" });
  assert.equal(result.code, 0, result.stderr);
  const key = result.stdout.split("\n")[0].split("#")[1];
  const body = JSON.parse(result.seen.find((call) => call.key === "POST /api/secret-links/e2e").raw);
  assert.equal(body.envelope.kdf.name, "PBKDF2");
  assert.equal(JSON.stringify(body).includes("example passphrase"), false);
  assert.throws(() => decryptVaultShare(body.envelope, key));
  assert.equal(decryptVaultShare(body.envelope, key, "example passphrase"), PASSWORD);
});
