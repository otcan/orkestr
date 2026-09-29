import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("release train runbook gates worker deployments through the train", async () => {
  const agents = await fs.readFile("AGENTS.md", "utf8");
  const doc = await fs.readFile("docs/release-train.md", "utf8");

  assert.match(agents, /docs\/release-train\.md/);
  assert.match(doc, /Only the release train may merge to `main`/);
  assert.match(doc, /Deployments go through this release train/);
  assert.match(doc, /Dirty worktrees are not automatically blockers/);
  assert.match(doc, /Conflicts are not automatically blockers/);
  assert.match(doc, /The release train owns tests/);
  assert.match(doc, /Then watch CI/);
  assert.match(doc, /Deploy only after local release checks and CI pass/);
  assert.match(doc, /Fast-forward workers that are ancestors/);
  assert.match(
    doc,
    /orkestr-wa-readiness\.mjs --bridge-url <url> --require-routing-policy --require-access-policy --account sender --account responder/,
  );
});

test("release train runbook documents the provenance gate modes and remaining repo-level work", async () => {
  const doc = await fs.readFile("docs/release-train.md", "utf8");
  assert.match(doc, /### Release provenance gate/);
  assert.match(doc, /`ORKESTR_DEPLOY_REQUIRE_CHECKS` \| `enforce`, `warn`, `off` \| `enforce`/);
  assert.match(doc, /`ORKESTR_DEPLOY_ARTIFACT_PROVENANCE` \| `off`, `warn`, `enforce` \| `warn`/);
  assert.match(doc, /`rollback` is never gated/);
  assert.match(doc, /ORK-478/);
  assert.match(doc, /orkestr release-train run \[--ref main\]/);
  assert.match(doc, /dependency-advisory-watch\.mjs/);
});
