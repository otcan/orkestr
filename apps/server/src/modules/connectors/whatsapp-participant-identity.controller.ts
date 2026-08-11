import { Body, Controller, HttpCode, HttpException, Post, Req } from "@nestjs/common";
import { migrateWhatsAppParticipantIdentityBindings } from "../../../../../packages/connectors/src/whatsapp-participant-identity-migration.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

@Controller("api/connectors/whatsapp/participant-identities")
export class WhatsAppParticipantIdentityController {
  @Post("migrate")
  @HttpCode(200)
  async migrate(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("admin_required", 403);
    try {
      return await migrateWhatsAppParticipantIdentityBindings({
        mode: String(body.mode || "dry-run"),
        env: process.env,
      });
    } catch (error) {
      throw new HttpException({
        error: String((error as Error)?.message || "wa_participant_identity_migration_failed"),
        diagnostics: (error as any)?.diagnostics || null,
      }, Number((error as any)?.statusCode || 500));
    }
  }
}
