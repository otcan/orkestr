import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const generatedDirs = new Set([".git", ".angular", "dist", "node_modules"]);

const knownCoreConnectorImports = new Set([
  "packages/core/src/codex-app-server-client.js",
  "packages/core/src/codex-app-server-common.js",
  "packages/core/src/codex-app-server.js",
  "packages/core/src/gmail-notifications.js",
  "packages/core/src/runtime-leases.js",
  "packages/core/src/setup.js",
  "packages/core/src/system-doctor.js",
  "packages/core/src/tenant-api-agent-tools.js",
  "packages/core/src/user-skills.js",
]);

const largeFileAllowlist = new Set([
  "apps/cli/src/commands.js",
  "apps/server/src/modules/connectors/connectors.controller.ts",
  "apps/server/src/modules/connectors/whatsapp-diagnostics.controller.ts",
  "apps/server/src/modules/system/system.controller.ts",
  "apps/server/src/modules/threads/threads.controller.ts",
  "apps/server/src/thread-stream.ts",
  "apps/server/src/thread-summary.ts",
  "apps/web/src/app/api.service.ts",
  "apps/web/src/app/app.component.html",
  "apps/web/src/app/app.component.ts",
  "apps/web/src/app/onboarding-page.component.css",
  "apps/web/src/app/onboarding-page.component.html",
  "apps/web/src/app/onboarding-page.component.ts",
  "apps/web/src/app/ops-page.component.html",
  "apps/web/src/app/ops-page.component.ts",
  "apps/web/src/styles.css",
  "packages/browsers/src/browsers.js",
  "packages/core/src/codex-app-server-client.js",
  "packages/core/src/codex-app-server-common.js",
  "packages/core/src/codex-app-server-recovery.js",
  "packages/core/src/codex-app-server.js",
  "packages/core/src/broker-instance-registry.js",
  "packages/core/src/jobs-jd-cache-mcp.js",
  "packages/core/src/runtime-leases.js",
  "packages/core/src/security.js",
  "packages/core/src/secure-secrets.js",
  "packages/core/src/system-doctor.js",
  "packages/core/src/tenant-api-agent-tools.js",
  "packages/core/src/tenant-api-agent.js",
  "packages/core/src/tenant-vm-provisioning.js",
  "packages/core/src/thread-workers.js",
  "packages/core/src/threads.js",
  "packages/core/src/timers.js",
  "packages/core/src/user-skills.js",
  "packages/connectors/src/codex.js",
  "packages/connectors/src/connector-outbox.js",
  "packages/connectors/src/gmail.js",
  "packages/connectors/src/google-workspace.js",
  "packages/connectors/src/whatsapp-account-bindings.js",
  "packages/connectors/src/whatsapp-broker-migration.js",
  "packages/connectors/src/whatsapp-local-bridge.js",
  "packages/connectors/src/whatsapp-outbound-mirror.js",
  "packages/connectors/src/whatsapp-security-approval.js",
  "packages/connectors/src/whatsapp.js",
]);

async function listFiles(dir) {
  const results = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (generatedDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

test("architecture guardrail: core connector imports are explicit legacy exceptions", async () => {
  const files = (await listFiles(path.join(repoRoot, "packages", "core", "src")))
    .filter((file) => /\.(js|ts)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.includes("../../connectors/src/")) continue;
    const rel = relative(file);
    if (!knownCoreConnectorImports.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test("architecture guardrail: new oversized source files require an explicit allowlist", async () => {
  const roots = ["apps", "packages"].map((dir) => path.join(repoRoot, dir));
  const files = (await Promise.all(roots.map(listFiles))).flat()
    .filter((file) => /\.(js|mjs|ts|html|css|scss)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const rel = relative(file);
    const lineCount = (await fs.readFile(file, "utf8")).split("\n").length;
    if (lineCount > 500 && !largeFileAllowlist.has(rel)) {
      offenders.push(`${rel}:${lineCount}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("architecture guardrail: runtime leases uses explicit runtime adapters", async () => {
  const raw = await fs.readFile(path.join(repoRoot, "packages/core/src/runtime-leases.js"), "utf8");
  assert.equal(raw.includes('from "./codex-app-server.js"'), false);
  assert.equal(raw.includes('from "./tmux-runtime.js"'), false);
  assert.equal(raw.includes('from "./runtime-codex-adapter.js"'), true);
  assert.equal(raw.includes('from "./runtime-tmux-legacy.js"'), true);
  assert.equal(/CodexAppServer|codexAppServer/.test(raw), false);
});
