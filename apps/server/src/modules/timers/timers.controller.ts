import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { createTimerForPrincipal, deleteTimerForPrincipal, doctorTimersForPrincipal, listTimersForPrincipal, runTimerNowForPrincipal, updateTimerForPrincipal } from "../../../../../packages/core/src/timers.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { connectorAuthStatus } from "../../../../../packages/connectors/src/connector-auth.js";
import { setTimerOwnershipForPrincipal } from "../../../../../packages/core/src/timer-ownership-service.js";
import { assertTimerWritable, listAgentJobScheduleTimersForPrincipal } from "../../../../../packages/core/src/agent-job-timer-entries.js";

@Controller("api/timers")
export class TimersController {
  @Get()
  async list(@Req() request: any) {
    const principal = requestPrincipal(request);
    // Agent Job schedule triggers are listed read-only after the stored timers.
    return { timers: [...await listTimersForPrincipal(principal), ...await listAgentJobScheduleTimersForPrincipal(principal)] };
  }

  @Get("doctor")
  async doctor(@Req() request: any) {
    return doctorTimersForPrincipal(requestPrincipal(request));
  }

  @Post()
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return { timer: await createTimerForPrincipal(body, requestPrincipal(request)) };
  }

  @Patch(":timerId")
  async update(@Req() request: any, @Param("timerId") timerId: string, @Body() body: Record<string, unknown> = {}) {
    assertTimerWritable(timerId);
    return { timer: await updateTimerForPrincipal(timerId, body, requestPrincipal(request)) };
  }

  @Delete(":timerId")
  async delete(@Req() request: any, @Param("timerId") timerId: string) {
    assertTimerWritable(timerId);
    return { ok: await deleteTimerForPrincipal(timerId, requestPrincipal(request)) };
  }

  @Post(":timerId/pause")
  @HttpCode(200)
  async pause(@Req() request: any, @Param("timerId") timerId: string) {
    assertTimerWritable(timerId);
    return { timer: await updateTimerForPrincipal(timerId, { enabled: false }, requestPrincipal(request)) };
  }

  @Post(":timerId/resume")
  @HttpCode(200)
  async resume(@Req() request: any, @Param("timerId") timerId: string) {
    assertTimerWritable(timerId);
    return { timer: await updateTimerForPrincipal(timerId, { enabled: true }, requestPrincipal(request)) };
  }

  // V1 <-> V2 timer handoff: body { ownedBy: "v2"|"v1", handoffId, enable? }.
  @Post(":timerId/ownership")
  @HttpCode(200)
  async ownership(@Req() request: any, @Param("timerId") timerId: string, @Body() body: Record<string, unknown> = {}) {
    assertTimerWritable(timerId);
    return setTimerOwnershipForPrincipal(timerId, body, requestPrincipal(request));
  }

  @Post(":timerId/run")
  @HttpCode(200)
  async run(@Req() request: any, @Param("timerId") timerId: string) {
    assertTimerWritable(timerId);
    const principal = requestPrincipal(request);
    return {
      event: await runTimerNowForPrincipal(timerId, principal, process.env, new Date(), {
        connectorStatusProvider: (provider: string, actualEnv: NodeJS.ProcessEnv, options: any = {}) =>
          connectorAuthStatus(provider, actualEnv, options),
      }),
    };
  }
}
