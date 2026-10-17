export function personalAgentFeature(env = process.env) {
  return { enabled: ["1", "true"].includes(String(env.ORKESTR_PERSONAL_AGENT_ENABLED || "").trim().toLowerCase()) };
}
