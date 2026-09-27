import crypto from "node:crypto";

export function claudeSystemPolicyRevision(thread = {}) {
  return String(thread?.claudeSystemPolicyRevision || "").trim();
}

export function nextClaudeSystemPolicyRevision() {
  return crypto.randomUUID();
}
