import { Body, Controller, Delete, Get, Param, Put, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { threadStandingMissionUpdateSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { ThreadStandingMissionService } from "./thread-application.services.js";
import { assertThreadAdminOnly } from "./thread-route-helpers.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function operatorUserId(request: any): string {
  const principal = requestPrincipal(request);
  return clean(principal?.userId || principal?.id || principal?.displayName || "admin") || "admin";
}

// Narrowly scoped: read/update/clear the standing mission field only. This is
// intentionally not a general thread-patch route -- admins who need other
// thread fields changed use the existing thread/worker/repo endpoints.
@Controller("api/threads")
export class ThreadStandingMissionController {
  constructor(private readonly missionService: ThreadStandingMissionService) {}

  @Get(":threadId/mission")
  async get(@Req() request: any, @Param("threadId") threadId: string) {
    assertThreadAdminOnly("thread.mission.get", requestPrincipal(request));
    try {
      return await this.missionService.get(threadId);
    } catch (error: any) {
      throw httpError(error?.message || "thread_mission_get_failed", error?.statusCode || 400);
    }
  }

  @Put(":threadId/mission")
  async set(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadStandingMissionUpdateSchema, { params: { threadId }, body });
    assertThreadAdminOnly("thread.mission.set", requestPrincipal(request));
    try {
      return await this.missionService.set(threadId, String(body.mission || ""), operatorUserId(request));
    } catch (error: any) {
      throw httpError(error?.message || "thread_mission_set_failed", error?.statusCode || 400);
    }
  }

  @Delete(":threadId/mission")
  async clear(@Req() request: any, @Param("threadId") threadId: string) {
    assertThreadAdminOnly("thread.mission.clear", requestPrincipal(request));
    try {
      return await this.missionService.clear(threadId, operatorUserId(request));
    } catch (error: any) {
      throw httpError(error?.message || "thread_mission_clear_failed", error?.statusCode || 400);
    }
  }
}
