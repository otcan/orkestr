import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { archiveStaleWhatsAppOutbox } from "../../../../../packages/connectors/src/whatsapp-outbox-stale-archive.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

@Controller("api/connectors/whatsapp/outbox-maintenance")
export class WhatsAppOutboxMaintenanceController {
  // Dry-run unless body.apply === true. Never sends or replays messages.
  @Post("archive-stale")
  @HttpCode(200)
  async archiveStale(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("whatsapp_outbox_admin_required", 403);
    try {
      return await archiveStaleWhatsAppOutbox({
        olderThan: String(body.olderThan || "7d"),
        apply: body.apply === true,
        limit: Number(body.limit || 0) || undefined,
        operator: String(body.operator || "operator"),
        reason: String(body.reason || ""),
      }, process.env);
    } catch (error) {
      throw httpError(String((error as Error)?.message || "stale_outbox_archive_failed"), Number((error as any)?.statusCode || 500));
    }
  }
}
