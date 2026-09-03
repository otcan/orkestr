import { Body, Controller, Post, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { vagentWebhookSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { VagentService } from "./vagent.service.js";

@Controller("api/integrations/vagent")
export class VagentController {
  constructor(private readonly vagent: VagentService) {}

  @Post()
  async webhook(@Req() request: any, @Body() body: Record<string, any> = {}) {
    // A browser session may be valid for the wider application, but this
    // ingress endpoint accepts only the route-specific Vagent machine token.
    if (request?.orkestrMachineAuth !== "vagent") throw httpError("vagent_auth_required", 401);
    validateRequestSchema(vagentWebhookSchema, { body });
    return this.vagent.process({
      principal: requestPrincipal(request),
      prompt: body.body.prompt,
      sessionId: body.body.sessionID,
    });
  }
}
