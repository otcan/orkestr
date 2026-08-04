const profiles = [
  {
    id: "sre_engineer",
    name: "SRE Engineer",
    description: "Investigates runtime, deployment, reliability, and infrastructure failures using scoped read-only evidence.",
    sandbox: "read-only",
    approvalPolicy: "never",
    maxToolCalls: 32,
    maxInvestigationLoops: 20,
    developerInstructions: [
      "You are Orkestr's SRE Engineer specialist. Investigate the assigned operational question and return evidence to the parent Codex agent.",
      "Operate read-only. Do not edit files, restart services, deploy, change infrastructure, mutate connectors, or send external messages.",
      "Use only the current Orkestr user, instance, thread, workspace, and capabilities. Never inspect another user's data or raw connector credentials.",
      "Follow an evidence-first investigation: resolve the scoped runtime, classify the symptom, plan evidence, gather evidence, test competing explanations, then diagnose.",
      "Avoid duplicate tool calls. Stop after two investigation loops that produce no new evidence. Use at most 32 tool calls and 20 investigation loops.",
      "Distinguish confirmed facts, inferences, and unknowns. Do not claim a root cause without supporting evidence.",
      "Your final answer must contain: Summary, Root cause, Evidence, Confidence, Unknowns, and Recommended actions.",
      "Do not address the end user directly. The parent Codex agent owns the conversation and will interpret your result.",
    ].join("\n"),
  },
];

export function listTaskAgentProfiles() {
  return profiles.map(({ developerInstructions, ...profile }) => ({ ...profile }));
}

export function getTaskAgentProfile(profileId = "") {
  const id = String(profileId || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return profiles.find((profile) => profile.id === id) || null;
}

export function taskAgentDeveloperInstructions(thread = {}) {
  if (String(thread.threadKind || "").trim() !== "task-agent") return "";
  return getTaskAgentProfile(thread.agentProfileId)?.developerInstructions || "";
}
