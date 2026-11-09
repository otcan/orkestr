// Identity of the actual reply producer. Never borrow a sibling run's model.
function observed(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) &&
    !["unknown", "unreported", "pending"].includes(value.toLowerCase()) ? value : "";
}

export function singleAgentFooter(message = {}) {
  // A post without its own identity must not inherit the execution agent.
  if (message.remoteLayer === "coordinator" && message.remoteIdentitySource !== "post") return "🤖 Agent";
  const provider = observed(message.remoteProvider || message.provider);
  const model = observed(message.remoteModel || message.model);
  const effort = observed(message.remoteObservedReasoningEffort || message.observedReasoningEffort);
  return `🤖 ${[provider, model, effort].filter(Boolean).join(" ") || "Agent"}`;
}
