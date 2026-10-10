// Fault injection for Agent Job runs (runtime-guarantees.md test sketches).
// A fault fires at a named point, optionally only for some attempts or tools:
//   { at: "effect_performed", attempts: [1], tool: "demo.pull_request.create", mode: "exit" | "throw" }
// mode "exit" SIGKILLs the process (a real kill -9); "throw" simulates the same
// death in-process: the runner stops without any further writes.
// Points: attempt_started, tool_requested, effect_intended, effect_dispatched,
// effect_performed (external call done, commit not yet written),
// effect_committed, approval_requested, final_output, notify.

export class InjectedCrash extends Error {
  constructor(point) {
    super(`agent_job_injected_crash:${point}`);
    this.code = "agent_job_injected_crash";
    this.injectedCrash = true;
    this.point = point;
  }
}

export function faultsFrom(options = {}, env = process.env) {
  if (Array.isArray(options.faults)) return options.faults;
  const raw = String(env.ORKESTR_AGENT_JOB_FAULTS || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function injectFault(faults, point, { attempt = null, tool = null } = {}) {
  for (const fault of faults || []) {
    if (fault?.at !== point) continue;
    if (Array.isArray(fault.attempts) && !fault.attempts.includes(attempt)) continue;
    if (fault.tool && fault.tool !== tool) continue;
    if (fault.mode === "exit") process.kill(process.pid, "SIGKILL");
    throw new InjectedCrash(point);
  }
}
