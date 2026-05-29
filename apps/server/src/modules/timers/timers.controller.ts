import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { createTimerForPrincipal, deleteTimerForPrincipal, doctorTimersForPrincipal, listTimersForPrincipal, runTimerNowForPrincipal } from "../../../../../packages/core/src/timers.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

@Controller("api/timers")
export class TimersController {
  @Get()
  async list(@Req() request: any) {
    return { timers: await listTimersForPrincipal(requestPrincipal(request)) };
  }

  @Get("doctor")
  async doctor(@Req() request: any) {
    return doctorTimersForPrincipal(requestPrincipal(request));
  }

  @Post()
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return { timer: await createTimerForPrincipal(body, requestPrincipal(request)) };
  }

  @Delete(":timerId")
  async delete(@Req() request: any, @Param("timerId") timerId: string) {
    return { ok: await deleteTimerForPrincipal(timerId, requestPrincipal(request)) };
  }

  @Post(":timerId/run")
  @HttpCode(200)
  async run(@Req() request: any, @Param("timerId") timerId: string) {
    return { event: await runTimerNowForPrincipal(timerId, requestPrincipal(request)) };
  }
}
