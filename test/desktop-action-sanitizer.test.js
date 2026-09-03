import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertDesktopActionSanitized } from "../packages/core/src/desktop-action-sanitizer.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { createThreadForPrincipal } from "../packages/core/src/threads.js";
import { upsertUser } from "../packages/core/src/users.js";

test("tenant desktop sanitizer receives computed desktop capabilities", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-sanitizer-caps-"));
  const captureFile = path.join(home, "sanitizer-payload.json");
  const sanitizer = path.join(home, "sanitizer.mjs");
  await fs.writeFile(sanitizer, [
    "import fs from 'node:fs';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(${JSON.stringify(captureFile)}, input);`,
    "  const payload = JSON.parse(input);",
    "  const caps = payload.resource?.capabilities || {};",
    "  const allow = caps.linkedin === true && caps.desktopLeases === true && caps.virtualBrowsers === true;",
    "  console.log(JSON.stringify({ allow, reason: allow ? 'desktop-capabilities-present' : 'desktop-capabilities-missing', model: 'test-llm' }));",
    "});",
    "",
  ].join("\n"), "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, sanitizer]),
  };
  const principal = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  await createTenantVm({
    id: "alice-tenant",
    ownerUserId: "alice",
    status: "running",
    capabilities: ["codex", "desks"],
    connectors: { linkedinDesktopSlug: "linkedin" },
  }, env);
  await createThreadForPrincipal({ id: "alice-thread", name: "Alice thread" }, principal, env);

  const decision = await assertDesktopActionSanitized({
    action: "acquire",
    principal,
    desktopSlug: "linkedin",
    input: { threadId: "alice-thread", purpose: "user_desk_action" },
  }, env);
  const payload = JSON.parse(await fs.readFile(captureFile, "utf8"));

  assert.equal(decision.allow, true);
  assert.equal(payload.action, "desktop.acquire");
  assert.equal(payload.resource.id, "linkedin");
  assert.equal(payload.resource.ownerUserId, "alice");
  assert.equal(payload.resource.capabilities.linkedin, true);
  assert.equal(payload.resource.capabilities.desktopLeases, true);
  assert.equal(payload.resource.capabilities.virtualBrowsers, true);
});
