export function personalAgentFeature(env = process.env) {
  const value = String(env.ORKESTR_PERSONAL_AGENT_ENABLED || "").trim().toLowerCase();
  return value === "1" || value === "true";
}
