// Offline helpers for the codex Agent Job executor: a `codex` shim that runs
// the conformance fake app-server, and a driver loop that simulates a process
// restart (stops the job app-server) after an injected crash.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearAgentJobProviderProbeCache, installAgentJobProviderProbes } from "../../packages/connectors/src/agent-job-provider-probes.js";
import { decideApproval, listApprovals } from "../../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../../packages/core/src/agent-job-runner.js";
import { stopCodexJobClients } from "../../packages/core/src/codex-job-client.js";
import { tempEnv } from "./agent-job-fixtures.js";

const fakePath = fileURLToPath(new URL("../conformance/fakes/fake-codex-app-server.mjs", import.meta.url));

// env for a run against the fake app-server; `script` is the scripted model.
export async function codexJobEnv({ script = [{ final: { summary: "done" } }], loggedIn = true, extra = {} } = {}) {
  const env = await tempEnv();
  const bin = path.join(env.ORKESTR_HOME, "bin", "codex");
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const login = loggedIn ? "" : "if [ \"$1\" = login ]; then echo 'Not logged in'; exit 1; fi\n";
  await fs.writeFile(bin, `#!/bin/sh\n${login}exec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
  return {
    ...env,
    HOME: path.join(env.ORKESTR_HOME, "runtime-home"),
    ORKESTR_CODEX_BIN: bin,
    FAKE_CODEX_STATE: path.join(env.ORKESTR_HOME, "fake-codex-state.json"),
    FAKE_CODEX_JOB_SCRIPT: JSON.stringify(script),
    FAKE_CODEX_STEP_MS: "5",
    FAKE_CODEX_STALE_USAGE_ON_RESUME: "1",
    ...extra,
  };
}

export async function readFakeCodex(env) {
  return JSON.parse(await fs.readFile(env.FAKE_CODEX_STATE, "utf8").catch(() => "{}"));
}

// The real provider probes (codex login status + app-server --help).
export function useRealProviderProbes() {
  installAgentJobProviderProbes();
  clearAgentJobProviderProbeCache();
}

// Drive to a terminal state, deciding every approval; an injected crash is
// followed by stopping the job app-server, like a real process death.
export async function driveCodexRun(runId, env, { decision = "approved", faults = [], rounds = 12 } = {}) {
  let result = null;
  const parked = [];
  for (let round = 0; round < rounds; round += 1) {
    try {
      result = await driveRun(runId, { faults }, env);
    } catch (error) {
      if (!error?.injectedCrash) throw error;
      stopCodexJobClients();
      continue;
    }
    if (result.state !== "awaiting_approval") return { ...result, parked };
    for (const approval of await listApprovals({ runId, state: "pending" }, env)) {
      parked.push(approval);
      await decideApproval(approval.approvalId, { decision: typeof decision === "function" ? decision(approval) : decision, by: "test" }, env);
    }
  }
  return { ...result, parked };
}
