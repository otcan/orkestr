import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

function runScript(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/secure-secrets-migrate-env.mjs", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr, json: JSON.parse(stdout) });
      else reject(new Error(`script failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function readTreeText(root) {
  let text = "";
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) text += await readTreeText(filePath);
    else text += await fs.readFile(filePath, "utf8").catch(() => "");
  }
  return text;
}

test("secure secret env migration dry-run reports metadata only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-secret-migrate-dry-"));
  const result = await runScript([], {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "super-secret-openai",
    GMAIL_OAUTH_CLIENT_SECRET: "super-secret-gmail",
  });
  assert.equal(result.json.mode, "dry_run");
  assert.deepEqual(result.json.migrated.map((item) => item.name), ["openai/api-key", "gmail/client-secret"]);
  assert.equal(result.stdout.includes("super-secret-openai"), false);
  assert.equal(result.stdout.includes("super-secret-gmail"), false);
  assert.equal(await readTreeText(home), "");
});

test("secure secret env migration writes encrypted secure-input records only with --write", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-secret-migrate-write-"));
  const result = await runScript(["--write", "--user", "alice"], {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "super-secret-openai",
  });
  assert.equal(result.json.mode, "write");
  assert.equal(result.json.scope, "user");
  assert.equal(result.json.ownerUserId, "alice");
  assert.equal(result.json.migrated[0].handle, "secret://user/alice/openai/api-key");
  assert.equal(result.stdout.includes("super-secret-openai"), false);
  const stored = await readTreeText(home);
  assert.match(stored, /encryptedValue/);
  assert.equal(stored.includes("super-secret-openai"), false);
});
