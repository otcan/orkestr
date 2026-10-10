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

export async function agentJobProviderStatus(provider, env = process.env) {
  const id = String(provider || "");
  if (id === "simulated") {
    return agentJobTestProvidersAllowed(env)
      ? { provider: id, connected: true, reason: "test_fixture" }
      : { provider: id, connected: false, reason: "test_only_provider" };
  }
  const probe = probes.get(id);
  if (!probe) return { provider: id, connected: false, reason: "provider_not_connected" };
  try {
    const status = await probe(env);
    return { provider: id, connected: status?.connected === true, reason: status?.reason || (status?.connected ? "connected" : "provider_not_connected") };
  } catch (error) {
    return { provider: id, connected: false, reason: String(error?.message || "probe_failed").slice(0, 200) };
  }
}

export async function connectedAgentJobProviders(env = process.env, candidates = ["codex", "claude-code"]) {
  const statuses = await Promise.all(candidates.map((provider) => agentJobProviderStatus(provider, env)));
  return statuses.filter((status) => status.connected).map((status) => status.provider);
}

export function providerNotConnectedError(provider, reason = "provider_not_connected") {
  return Object.assign(new Error(`provider_not_connected: ${provider} (${reason}); ${connectProviderHint}`), {
    code: "provider_not_connected",
    statusCode: 409,
    provider,
    reason,
  });
}
