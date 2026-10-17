import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTenantApiAgentTool } from "../packages/core/src/tenant-api-agent-tools.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { upsertUser } from "../packages/core/src/users.js";

// Agent desktop skill actions (open, open_url, stop, ...) are refused while an
// owner password handoff blinds the desktop. Synthetic profile desktop only.
test("tenant agent desktop skill actions are refused on a password-blind desktop", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-agent-tools-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await fs.writeFile(path.join(home, "password-handoffs.json"), JSON.stringify({ handoffs: [{
    id: "pwh_tools", ownerUserId: "otcan", threadId: "t", desktopSlug: "linkedin", targetId: "x", origin: "https://signup.example.test",
    selector: "", state: "open", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(),
  }] }));
  for (const [action, url] of [["open", ""], ["open_url", "https://example.test/"]]) {
    const result = await runTenantApiAgentTool("orkestr_run_skill_action", { skillId: "linkedin", action, target: "", url }, { principal }, env);
    assert.equal(result.ok, false, action);
    assert.equal(result.error, "desktop_password_blind", action);
  }
});
