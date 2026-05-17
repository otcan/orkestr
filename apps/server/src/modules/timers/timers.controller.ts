import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { createTimer, deleteTimer, doctorTimers, listTimers, runTimerNow } from "../../../../../packages/core/src/timers.js";

@Controller("api/timers")
export class TimersController {
  @Get()
  async list() {
    return { timers: await listTimers() };
  }

  @Get("doctor")
  async doctor() {
    return doctorTimers();
  }

  @Post()
  async create(@Body() body: Record<string, unknown> = {}) {
    return { timer: await createTimer(body) };
  }

  @Delete(":timerId")
  async delete(@Param("timerId") timerId: string) {
    return { ok: await deleteTimer(timerId) };
  }

  @Post(":timerId/run")
  @HttpCode(200)
  async run(@Param("timerId") timerId: string) {
    return { event: await runTimerNow(timerId) };
  }
}
