import { Controller, Get, Query, Req } from "@nestjs/common";
import { personalAgentCapability } from "../../../../../packages/core/src/personal-agent-capability.js";
import { personalAgentEventFeed } from "../../../../../packages/core/src/personal-agent-events.js";

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
}
