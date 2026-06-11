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
  const userGuide = await read("docs/user-guide.md");
  const architecture = await read("docs/architecture.md");
  const demoLog = await read("docs/demo-logs/coding-agent-first-run.md");
  const example = await read("examples/coding-agent-demo/README.md");

  assert.match(readme, /Why This Exists/);
  assert.match(readme, /Documentation Map/);
  assert.match(readme, /docker run -p 3000:3000 -v orkestr-data:\/data orkestr\/orkestr:latest/);
  assert.match(readme, /helm install orkestr \.\/charts\/orkestr/);
  assert.match(readme, /curl -fsSL/);
  assert.match(readme, /docs\/user-guide\.md/);
  assert.match(readme, /flowchart LR/);
  assert.match(readme, /Security Model/);
  assert.match(readme, /Docker\/Helm path is the primary OSS demo path/);
  assert.match(readme, /ROADMAP\.md/);
  assert.match(userGuide, /Public Facing Layer/);
  assert.match(userGuide, /Connect WhatsApp/);
  assert.match(userGuide, /Run Codex Agents/);
  assert.match(contributing, /Pull Request Checklist/);
  assert.match(contributing, /Automation Map/);
  assert.match(contributing, /smoke:vps:aws/);
  assert.match(security, /Do not expose/);
  assert.match(security, /out\s+of\s+the\s+box/);
  assert.match(readme, /orkestr-three-screen-demo\.png/);
  assert.match(readme, /generated WhatsApp source panel/);
  assert.match(readme, /TMUX capture/);
  assert.match(roadmap, /disposable fake-data runs/);
  assert.doesNotMatch(roadmap, /Virtual Desktop Generation/);
  assert.match(architecture, /Legacy `\/ng\/\*` paths/);
  assert.match(demoLog, /Coding-agent demo passed/);
  assert.match(readme, /smoke:k3s:oss-demo/);
  assert.match(readme, /Start the default `orkest` thread/);
  assert.match(readme, /Orkestr relay or your own WhatsApp bridge/);
  assert.match(readme, /Virtual Desk startup wiring/);
  assert.match(example, /Codex signed in from the Orkestr setup page/);
  assert.doesNotMatch(example, /Codex workflow/);
});
