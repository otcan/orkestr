import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureRuntimeAgentsFile } from "../packages/core/src/agent-context.js";
import { CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE } from "../packages/core/src/claude-code-runtime-notices.js";

// Prose paths and Markdown links are never attached (ORK-501/502), so agents
// must be told the explicit form or files silently never reach the user.
test("agents are told to attach files with explicit file:// links", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attach-guide-"));
  const workspace = path.join(home, "workspaces", "t");
  await fs.mkdir(workspace, { recursive: true });
  const env = { ORKESTR_HOME: home, ORKESTR_RUNTIME_WORKSPACE_ROOT: path.join(home, "workspaces") };
  await ensureRuntimeAgentsFile(workspace, env, { thread: { id: "t" } });
  const agents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  assert.match(agents, /\[name\]\(file:\/\/\/absolute\/path\)/);
  assert.match(agents, /never attached/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /file:\/\/\/absolute\/path/);
  await fs.rm(home, { recursive: true, force: true });
});
