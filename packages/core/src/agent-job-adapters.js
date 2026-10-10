// Provider adapters for Agent Job runs (docs/spec/adapter-interface.md).
//
// Two shapes are supported by the runner:
// * toolLoop "orkestr": `step(ctx, state)` returns the next model action
//   ({type:"message"} | {type:"tool"} | {type:"final"}); Orkestr runs every tool
//   through authorization and the effect ledger. Resume is "transcript": the
//   runner passes back every completed step, so a new attempt continues after
//   the last checkpointed step.
// * toolLoop "native": `run(ctx, input)` runs the provider's own loop and
//   returns { output } (or a park/cancel outcome, agent-job-native-attempt.js).
//   `codex` runs on the Codex app-server (agent-job-codex.js) with its tool
//   calls routed through the runner. `claude-code` still goes through the
//   executor registry; its own tools are not visible to the runner (see the
//   gaps in docs/spec/agent-job-runner.md).
import { codexJobAdapter } from "./agent-job-codex.js";
import { agentJobTestProvidersAllowed } from "./agent-job-spec.js";
import { getExecutorAdapter, loadOverlayExecutorAdapters } from "./executors.js";

const adapters = new Map();

export function registerAgentJobAdapter(adapter) {
  if (!adapter?.id) throw new Error("agent_job_adapter_id_required");
  const previous = adapters.get(adapter.id) || null;
  adapters.set(adapter.id, adapter);
  return () => {
    if (previous) adapters.set(adapter.id, previous);
    else adapters.delete(adapter.id);
  };
}

export function getAgentJobAdapter(id, env = process.env) {
  const adapter = adapters.get(String(id || "")) || null;
  // The simulated adapter is a test fixture: never resolvable outside node --test.
  if (adapter?.testOnly && !agentJobTestProvidersAllowed(env)) return null;
  return adapter;
}

export function providerError(message, { retryable = true, kind = "provider" } = {}) {
  return Object.assign(new Error(message), { kind, retryable });
}

// Map an arbitrary failure to { kind: provider|task|timeout, retryable }.
export function classifyAdapterError(error) {
  if (error?.kind && ["provider", "task", "timeout"].includes(error.kind)) {
    return { kind: error.kind, retryable: error.retryable !== false, message: String(error.message || error.kind) };
  }
  const text = String(error?.message || error || "");
  const status = Number(error?.statusCode || error?.status || 0);
  if (/rate.?limit|429|unavailable|overloaded|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(text) || status === 429 || status >= 500 && status !== 501) {
    return { kind: "provider", retryable: true, message: text };
  }
  if (/auth|unauthori[sz]ed|forbidden|not_configured|executor_not_found|login/i.test(text) || status === 401 || status === 403 || status === 501) {
    return { kind: "provider", retryable: false, message: text };
  }
  return { kind: "task", retryable: false, message: text };
}

// ---- simulated: test fixture only (conformance/CI), never a user provider ----

function defaultScript(input) {
  const prompt = String(input.prompt || "").trim().split("\n")[0].slice(0, 200);
  return [
    { say: `Simulated provider received: ${prompt}` },
    { output: { summary: "Simulated run completed." } },
  ];
}

function scriptFor(input) {
  const script = input.inputs?.simulated_script;
  return Array.isArray(script) && script.length ? script : defaultScript(input);
}

export const simulatedJobAdapter = Object.freeze({
  id: "simulated",
  testOnly: true,
  capabilities: Object.freeze({
    toolLoop: "orkestr",
    resume: "transcript",
    interrupt: "kill",
    streaming: false,
    structuredOutput: "validate",
    permissionHook: "orkestr",
    sandbox: "none",
    usage: false,
  }),
  async probe() {
    return { ok: true };
  },
  // Steps: {say}, {tool, args}, {output}, and {fail: {kind, retryable,
  // message}, on_attempts: [n]} to inject provider/task errors.
  async step(ctx, state) {
    const script = scriptFor(state.input);
    const done = state.transcript.reduce((max, entry) => Math.max(max, Number(entry.stepIndex ?? -1)), -1);
    for (let index = done + 1; index < script.length; index += 1) {
      const step = script[index] || {};
      if (step.fail) {
        const attempts = Array.isArray(step.on_attempts) ? step.on_attempts : [1];
        const providers = Array.isArray(step.on_providers) ? step.on_providers : null;
        if (attempts.includes(ctx.attempt) && (!providers || providers.includes(ctx.provider))) {
          const fail = typeof step.fail === "object" ? step.fail : { message: String(step.fail) };
          throw Object.assign(new Error(fail.message || "simulated_failure"), { kind: fail.kind || "provider", retryable: fail.retryable !== false });
        }
        continue;
      }
      if (step.say !== undefined) return { type: "message", text: String(step.say), stepIndex: index };
      if (step.tool) return { type: "tool", tool: String(step.tool), args: step.args || {}, stepIndex: index };
      if (step.output !== undefined) return { type: "final", output: step.output, stepIndex: index };
    }
    return { type: "final", output: { summary: "Simulated script finished." }, stepIndex: script.length };
  },
});

// ---- codex / claude-code: one native turn through the executor registry ----

const executorIdsByProvider = Object.freeze({ codex: ["codex"], "claude-code": ["claude-code", "claude"] });

// The executor that can really run a job attempt for `provider`, or null: a
// registered job-attempt adapter (`jobExecutor`, e.g. codex on the app-server)
// or a real executor from the registry. getExecutorAdapter() falls back to the
// no-op executor and the built-in thread `codex` executor is a placeholder;
// neither counts.
export async function agentJobExecutorFor(provider, env = process.env) {
  const adapter = adapters.get(String(provider || ""));
  if (adapter?.jobExecutor && !adapter.testOnly) return adapter;
  await loadOverlayExecutorAdapters(env);
  for (const id of executorIdsByProvider[provider] || []) {
    const executor = getExecutorAdapter(id);
    if (executor && executor.id === id && !executor.placeholder) return executor;
  }
  return null;
}

function nativeExecutorAdapter(id) {
  return Object.freeze({
    id,
    capabilities: Object.freeze({
      toolLoop: "native",
      resume: "none",
      interrupt: "kill",
      streaming: false,
      structuredOutput: "validate",
      permissionHook: "sandbox_only",
      sandbox: "workspace_write",
      usage: false,
    }),
    async probe(ctx) {
      const executor = await agentJobExecutorFor(id, ctx.env);
      return executor ? { ok: true } : { ok: false, reason: "job_executor_unavailable" };
    },
    async run(ctx, input) {
      const executor = await agentJobExecutorFor(id, ctx.env);
      if (!executor) throw providerError("job_executor_unavailable", { retryable: false });
      const text = [
        input.prompt,
        input.resumeSummary ? `\n\nResume context:\n${input.resumeSummary}` : "",
        Object.keys(input.inputs || {}).length ? `\n\nInputs:\n${JSON.stringify(input.inputs, null, 2)}` : "",
        // e.g. the triggering WhatsApp message and its quoted/reply context.
        input.triggerEvent ? `\n\nTrigger event:\n${JSON.stringify(input.triggerEvent, null, 2)}` : "",
      ].join("");
      const thread = { id: `agent-job-${ctx.runId}`, name: `agent job ${ctx.job}`, executor: { id: executor.id, model: input.model || undefined } };
      const message = { id: `${ctx.runId}-a${ctx.attempt}`, role: "user", source: "agent-job", text, state: "running" };
      try {
        const result = await executor.run({ thread, threadId: thread.id, message, execution: { id: message.id }, env: ctx.env });
        return { output: result?.output ?? result?.text ?? result ?? null };
      } catch (error) {
        const classified = classifyAdapterError(error);
        throw Object.assign(new Error(classified.message), classified);
      }
    },
  });
}

registerAgentJobAdapter(simulatedJobAdapter);
registerAgentJobAdapter(codexJobAdapter);
registerAgentJobAdapter(nativeExecutorAdapter("claude-code"));
