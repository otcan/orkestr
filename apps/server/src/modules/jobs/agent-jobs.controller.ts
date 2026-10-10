import { Body, Controller, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { handleAgentJobTrigger } from "../../../../../packages/core/src/agent-job-http.js";

// Agent Job triggers (docs/spec/agent-job.md §1.1). Job alerts keep the other
// /api/jobs routes in jobs.controller.ts.
@Controller("api/jobs")
export class AgentJobsController {
  @Post(":name/trigger")
  @HttpCode(202)
  async trigger(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Param("name") name: string,
    @Query() query: Record<string, unknown> = {},
    @Body() body: Record<string, unknown> = {},
  ) {
    const result = await handleAgentJobTrigger({
      name,
      query,
      body,
      headers: request.headers || {},
      principal: request.orkestrPrincipal || null,
      machineAuth: request.orkestrMachineAuth || null,
      anonymous: request.orkestrAnonymous === true,
    }, process.env);
    response.status(result.statusCode);
    return result.body;
  }
}
