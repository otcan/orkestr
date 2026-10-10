// Provider connectivity for Agent Jobs. Owner decision (2026-10-10): a job
// must use a real, connected provider. Runs are neither admitted nor started
// for a provider that is not connected. `simulated` is a test fixture and is
// "connected" only inside node --test.
//
// Probes live in the apps/connectors layer (packages/connectors/src/
// agent-job-provider-probes.js) and register here; with no probe registered a
// provider counts as not connected (fail closed).
import { agentJobTestProvidersAllowed } from "./agent-job-spec.js";

const probes = new Map();

export const connectProviderHint =
  "connect Codex or Claude first: run `codex login` or `claude auth login` on this host (or connect one in the setup wizard), then retry. Orkestr jobs need a real connected provider.";

export function setAgentJobProviderProbe(provider, probe, { ifAbsent = false } = {}) {
  const previous = probes.get(provider) || null;
  if (ifAbsent && previous) return () => {};
  probes.set(provider, probe);
  return () => {
    if (previous) probes.set(provider, previous);
    else probes.delete(provider);
  };
}

// Status of one provider:
//   connected - the user's login works (codex: login status + app-server;
//               claude-code: `claude auth status`)
//   runnable  - connected AND Orkestr has a job executor for it
// Jobs are admitted and started only on runnable providers.
export async function agentJobProviderStatus(provider, env = process.env) {
  const id = String(provider || "");
  if (id === "simulated") {
    return agentJobTestProvidersAllowed(env)
      ? { provider: id, connected: true, runnable: true, reason: "test_fixture" }
      : { provider: id, connected: false, runnable: false, reason: "test_only_provider" };
  }
  const probe = probes.get(id);
  if (!probe) return { provider: id, connected: false, runnable: false, reason: "provider_not_connected" };
  try {
    const status = await probe(env);
    const connected = status?.connected === true;
    const runnable = connected && status?.runnable !== false;
    return { provider: id, connected, runnable, reason: status?.reason || (runnable ? "connected" : connected ? "job_executor_unavailable" : "provider_not_connected") };
  } catch (error) {
    return { provider: id, connected: false, runnable: false, reason: String(error?.message || "probe_failed").slice(0, 200) };
  }
}

export async function agentJobProviderStatuses(env = process.env, candidates = ["codex", "claude-code"]) {
  return Promise.all(candidates.map((provider) => agentJobProviderStatus(provider, env)));
}

export async function connectedAgentJobProviders(env = process.env, candidates = ["codex", "claude-code"]) {
  return (await agentJobProviderStatuses(env, candidates)).filter((status) => status.connected).map((status) => status.provider);
}

export const executorUnavailableHint =
  "the provider is logged in, but this Orkestr install has no job executor for it yet (codex jobs use the built-in Codex app-server executor; claude-code needs an executor registered by an overlay; see docs/spec/agent-job-runner.md)";

export function providerNotConnectedError(provider, reason = "provider_not_connected") {
  const hint = reason === "job_executor_unavailable" ? executorUnavailableHint : connectProviderHint;
  return Object.assign(new Error(`provider_not_connected: ${provider} (${reason}); ${hint}`), {
    code: "provider_not_connected",
    statusCode: 409,
    provider,
    reason,
  });
}
