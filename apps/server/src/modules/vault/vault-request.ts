import { vaultAgentRequest, vaultOwnerFromRequest } from "../../../../../packages/core/src/vault-access.js";
import { httpError } from "../../common/http.js";
import { originPolicyViolation } from "../../request-security.js";

// Request guards for the vault API. Owner endpoints need a real, unscoped
// browser session (see vaultOwnerFromRequest); state-changing owner calls must
// also pass the same-origin policy. Agent endpoints need the local CLI
// machine credential.

export const SECURE_RESPONSE_HEADER = "noMirror,noCapture,noCodexContext,noScreenshot";

export function vaultOwner(request: any, { mutating = false }: { mutating?: boolean } = {}) {
  const principal = vaultOwnerFromRequest(request);
  if (!principal) throw httpError("vault_owner_session_required", request?.orkestrMachineAuth ? 403 : 401);
  if (mutating) {
    const violation = originPolicyViolation(request);
    if (violation) throw httpError(violation, 403);
  }
  return principal;
}

export function vaultAgent(request: any) {
  if (!vaultAgentRequest(request)) throw httpError("vault_agent_cli_required", 403);
}
