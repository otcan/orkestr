import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

test("tenant isolation release suite is named and wired into the release train", async () => {
  const pkg = await readJson("package.json");
  const releaseTrain = await fs.readFile("docs/release-train.md", "utf8");
  const checklist = await fs.readFile("docs/tenant-isolation-release-checklist.md", "utf8");
  const containmentMatrix = await fs.readFile("docs/containment-matrix.md", "utf8");
  const routeSecurityMatrix = await fs.readFile("docs/route-security-matrix.md", "utf8");
  const command = pkg.scripts?.["test:tenant-isolation"] || "";

  assert.match(command, /test\/use-control\.test\.js/);
  assert.match(command, /test\/security\.test\.js/);
  assert.match(command, /test\/gmail\.test\.js/);
  assert.match(command, /test\/outlook\.test\.js/);
  assert.match(command, /test\/browsers\.test\.js/);
  assert.match(command, /test\/codex-app-server\.test\.js/);
  assert.match(command, /test\/whatsapp\.test\.js/);
  assert.match(command, /test\/whereiam\.test\.js/);
  assert.match(releaseTrain, /npm run test:tenant-isolation/);
  assert.match(releaseTrain, /tenant isolation release checklist/);
  assert.match(checklist, /Non-admin thread visibility/);
  assert.match(checklist, /Per-user workspace and file roots/);
  assert.match(checklist, /LLM sanitizer fail-closed/);
  assert.match(checklist, /User-scoped Gmail and Outlook OAuth/);
  assert.match(checklist, /Browser desktop profile and lease isolation/);
  assert.match(checklist, /Contained user Codex runtime policy/);
  assert.match(checklist, /WhatsApp auto-provisioning/);
  assert.match(checklist, /whereiam/);
  assert.match(checklist, /tenant VM or tenant/);
  assert.match(checklist, /defense-in-depth/);
  assert.match(checklist, /containment matrix/);
  assert.match(checklist, /route ownership/);
  assert.match(checklist, /WebSocket/);
  assert.match(checklist, /No new runtime interruption notice/);
  assert.doesNotMatch(checklist, /orkestr\.app\.ops|crawlerai\.de|@g\.us|gmail\.com/);
  assert.match(containmentMatrix, /public isolation baseline is a dedicated tenant VM/);
  assert.match(containmentMatrix, /Shared-process checks are defense-in-depth only/);
  assert.match(containmentMatrix, /Fail-closed rule/);
  assert.match(containmentMatrix, /whereiam/);
  assert.match(containmentMatrix, /Code execution and Codex runtime/);
  assert.match(containmentMatrix, /Release regression/);
  assert.doesNotMatch(containmentMatrix, /orkestr\.app\.ops|crawlerai\.de|@g\.us|gmail\.com/);
  assert.match(routeSecurityMatrix, /Route Security Matrix/);
  assert.match(routeSecurityMatrix, /Thread summary WebSocket/);
  assert.match(routeSecurityMatrix, /Thread raw terminal/);
  assert.match(routeSecurityMatrix, /Control-plane routes require admin/);
  assert.match(routeSecurityMatrix, /control_plane_admin_required/);
  assert.doesNotMatch(routeSecurityMatrix, /orkestr\.app\.ops|crawlerai\.de|@g\.us|gmail\.com/);
});
