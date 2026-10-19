import { Body, Controller, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import { personalAgentCapability } from "../../../../../packages/core/src/personal-agent-capability.js";
import { personalAgentEventFeed } from "../../../../../packages/core/src/personal-agent-events.js";
import { acceptPersonalAgentMessage } from "../../../../../packages/core/src/personal-agent-ingress.js";

@Controller("api/personal-agent")
export class PersonalAgentController {
  @Get("capability")
  capability(@Req() request: any) {
    return personalAgentCapability(request);
  }

  @Get("events")
  events(@Req() request: any, @Query() query: any) {
    return personalAgentEventFeed(request, query);
  }

  @Post("messages")
  @HttpCode(202)
  acceptMessage(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return acceptPersonalAgentMessage(request, body);
  }
}
