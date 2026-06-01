import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { httpError } from "../../common/http.js";

export function assertThreadAdminOnly(action: string, principal: any) {
  if (isAdminPrincipal(principal)) return;
  throw httpError(`${action.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_admin_required`, 403);
}

export function threadIsActive(status: Record<string, any> | null | undefined): boolean {
  return Boolean(
    status?.working ||
    status?.foregroundWorking ||
    status?.typingActive ||
    Number(status?.runningCount || 0) > 0 ||
    Number(status?.pendingCount || 0) > 0,
  );
}
