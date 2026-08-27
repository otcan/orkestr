import { Controller, Get, Query, Req } from "@nestjs/common";
import { listLauncherApps } from "../../../../../packages/core/src/app-launcher.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

function includeHealth(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

@Controller("api")
export class AppsController {
  @Get("apps")
  async listApps(@Req() request: any, @Query("health") health: string) {
    return listLauncherApps({
      principal: requestPrincipal(request),
      includeHealth: includeHealth(health),
    });
  }
}
