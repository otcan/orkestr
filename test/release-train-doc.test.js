import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("V2 train promotes the exact source only after production acceptance", async () => {
  const doc = await fs.readFile("docs/release-train.md", "utf8");
  assert.match(doc, /feature branch → integration → prod → main/);
  assert.match(doc, /Only the release train selects prod, promotes main/);
  assert.match(doc, /fast-forwards `main` to the \*\*same commit\*\* after\nproduction acceptance/);
  assert.match(doc, /failed or\nunverified deployment leaves main unchanged/);
  assert.match(doc, /Moving `prod` or `main` does not rebuild/);
  assert.doesNotMatch(doc, /## Phase 6: Merge To Main/);
});

test("release train runbook documents the provenance gate modes and remaining repo-level work", async () => {
  const doc = await fs.readFile("docs/release-train-v1.md", "utf8");
  assert.match(doc, /### Release provenance gate/);
  assert.match(doc, /`ORKESTR_DEPLOY_REQUIRE_CHECKS` \| `enforce`, `warn`, `off` \| `enforce`/);
  assert.match(doc, /`ORKESTR_DEPLOY_ARTIFACT_PROVENANCE` \| `off`, `warn`, `enforce` \| `warn`/);
  assert.match(doc, /`rollback` is never gated/);
  assert.match(doc, /ORK-478/);
  assert.match(doc, /orkestr release-train run \[--ref main\]/);
  assert.match(doc, /dependency-advisory-watch\.mjs/);
});
