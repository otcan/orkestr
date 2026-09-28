import { Controller, Get, Query, Req } from "@nestjs/common";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { providerQuotaSnapshot } from "../../../../../packages/core/src/provider-quota-snapshot.js";
import { adminUserId, normalizeUserId } from "../../../../../packages/core/src/users.js";
import { httpError } from "../../common/http.js";

function ownerForRequest(request: any, requested = ""): string {
  const principal = requestPrincipal(request);
  const own = normalizeUserId(principal?.userId || process.env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const target = normalizeUserId(requested || own);
  if (!target) throw httpError("provider_quota_owner_required", 403);
  if (!isAdminPrincipal(principal) && target !== own) throw httpError("provider_quota_owner_mismatch", 403);
  return target;
}

// Remaining subscription quota for both executors (Codex and Claude Code).
// Only derived percentages, reset times and freshness are returned.
@Controller("api/quota")
export class ProviderQuotaController {
  @Get("providers")
  async providers(@Req() request: any, @Query("ownerUserId") requestedOwner = "") {
    const ownerUserId = ownerForRequest(request, requestedOwner);
    return { quota: await providerQuotaSnapshot({ ownerUserId }, process.env) };
  }
}
