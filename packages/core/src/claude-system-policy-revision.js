import crypto from "node:crypto";

function truthy(value = "") {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}

export function claudeSystemPolicyRevision(thread = {}, env = process.env) {
  const threadRevision = String(thread?.claudeSystemPolicyRevision || "").trim();
  const hostRevision = truthy(env.ORKESTR_CLAUDE_CODE_ROOT_ACCESS) ? "root-access-v1" : "";
  return [threadRevision, hostRevision].filter(Boolean).join(":");
}

export function nextClaudeSystemPolicyRevision() {
  return crypto.randomUUID();
}
