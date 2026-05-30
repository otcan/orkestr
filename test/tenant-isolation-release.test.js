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
  const command = pkg.scripts?.["test:tenant-isolation"] || "";

  assert.match(command, /test\/use-control\.test\.js/);
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
  assert.match(checklist, /No new runtime interruption notice/);
  assert.doesNotMatch(checklist, /orkestr\.app\.ops|crawlerai\.de|@g\.us|gmail\.com/);
});
