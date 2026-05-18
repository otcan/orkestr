import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function read(path) {
  return fs.readFile(path, "utf8");
}

test("public launch docs expose the minimum launch surface", async () => {
  const readme = await read("README.md");
  const contributing = await read("CONTRIBUTING.md");
  const security = await read("SECURITY.md");
  const roadmap = await read("ROADMAP.md");
  const architecture = await read("docs/architecture.md");
  const demoLog = await read("docs/demo-logs/coding-agent-first-run.md");
  const example = await read("examples/coding-agent-demo/README.md");

  assert.match(readme, /Why This Exists/);
  assert.match(readme, /curl -fsSL/);
  assert.match(readme, /docs\/assets\/orkestr-demo\.gif/);
  assert.match(readme, /flowchart LR/);
  assert.match(readme, /Security Warning/);
  assert.match(readme, /ROADMAP\.md/);
  assert.match(contributing, /Pull Request Checklist/);
  assert.match(security, /Do not expose/);
  assert.match(roadmap, /Secure access onboarding/);
  assert.match(architecture, /Legacy `\/ng\/\*` paths/);
  assert.match(demoLog, /Coding-agent demo passed/);
  assert.match(readme, /Local Docker/);
  assert.match(readme, /VPS Host-Native/);
  assert.match(readme, /sudo bash -s -- --systemd/);
  assert.match(readme, /orkestr security approve <challenge-id>/);
  assert.match(example, /Codex signed in from the Orkestr setup page/);
});
