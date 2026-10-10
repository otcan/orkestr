// Resolves Agent Job `vault://<name>` refs (webhook `secret_ref`, webhook
// notification targets) through the existing secure secret manager
// (secure-secrets.js): the owner's user secret first, then the global one.
// Values are returned to the caller only; they are never logged, audited or
// written to the Agent Job store.
import { resolveSecureSecretValue } from "./secure-secrets.js";
import { defaultAdminUser } from "./users.js";

const VAULT_REF_RE = /^vault:\/\/([A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/;

export function isAgentJobSecretRef(ref) {
  return VAULT_REF_RE.test(String(ref || "").trim());
}

/** @returns {Promise<string | null>} the secret value, or null when the ref is invalid or unset. */
export async function resolveAgentJobSecret(ref, { usedBy = "agent_job" } = {}, env = process.env) {
  const name = String(ref || "").trim().match(VAULT_REF_RE)?.[1];
  if (!name) return null;
  const resolved = await resolveSecureSecretValue(name, { ownerUserId: defaultAdminUser(env).id, usedBy }, env).catch(() => null);
  const value = resolved?.value === undefined || resolved?.value === null ? "" : String(resolved.value);
  return value ? value : null;
}
