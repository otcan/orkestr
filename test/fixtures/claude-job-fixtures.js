// Offline helper for the claude-code Agent Job executor: a `claude` shim that
// runs fixtures/fake-claude-job.mjs with a scripted plan of turns.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempEnv } from "./agent-job-fixtures.js";

const fakePath = fileURLToPath(new URL("./fake-claude-job.mjs", import.meta.url));

export async function fakeClaude(turns, extra = {}) {
  const env = await tempEnv();
  const dir = path.join(env.ORKESTR_HOME, "fake-claude");
  await fs.mkdir(dir, { recursive: true });
  const files = { plan: path.join(dir, "plan.json"), calls: path.join(dir, "calls.jsonl"), ran: path.join(dir, "ran.jsonl") };
  await fs.writeFile(files.plan, JSON.stringify({ turns }));
  const bin = path.join(dir, "claude");
  await fs.writeFile(bin, `#!/bin/sh\nFAKE_CLAUDE_JOB_PLAN="${files.plan}" FAKE_CLAUDE_JOB_CALLS="${files.calls}" FAKE_CLAUDE_JOB_RAN="${files.ran}" exec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
  const jsonl = async (file) => (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    env: { ...env, ORKESTR_CLAUDE_CODE_BIN: bin, HOME: path.join(env.ORKESTR_HOME, "host-home"), PATH: process.env.PATH, ORKESTR_CANARY_SECRET: "must-not-leak", ...extra },
    calls: () => jsonl(files.calls),
    ran: () => jsonl(files.ran),
  };
}
