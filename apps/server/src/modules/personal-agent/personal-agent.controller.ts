import { Controller, Get, Req } from "@nestjs/common";
import { personalAgentCapability } from "../../../../../packages/core/src/personal-agent-capability.js";

@Controller("api/personal-agent")
export class PersonalAgentController {
  @Get("capability")
  capability(@Req() request: any) {
    return personalAgentCapability(request);
  }
}
