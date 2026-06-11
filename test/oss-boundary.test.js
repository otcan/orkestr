import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

function runBoundaryCheck() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/oss-boundary-check.mjs"], {
      cwd: repoRoot,
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
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`oss-boundary-check failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

test("OSS boundary check passes for public repo", async () => {
  const result = await runBoundaryCheck();
  assert.match(result.stdout, /OSS boundary check passed/);
});

test("OSS boundary docs define the simplified and managed surfaces", async () => {
  const boundary = await fs.readFile(path.join(repoRoot, "docs/oss-managed-boundary.md"), "utf8");
  const secrets = await fs.readFile(path.join(repoRoot, "docs/secret-manager.md"), "utf8");
  assert.match(boundary, /self-hosted Codex control center/);
  assert.match(boundary, /Managed\/Private Repo Or Overlay/);
  assert.match(boundary, /npm run oss:boundary-check/);
  assert.match(secrets, /metadata only/);
  assert.match(secrets, /secret:\/\/user\/<user-id>\/<name>/);
});
