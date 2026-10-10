import { Controller, Get, Query, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { summarizeEvents } from "../../../../../packages/core/src/events-summary.js";
import { httpError } from "../../common/http.js";

// Event counts by type and top failure codes, for `orkestr doctor events`.
// Admin only.
@Controller("api/system/events")
export class EventsSummaryController {
  @Get("summary")
  async summary(@Req() request: any, @Query("since") since?: string) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("forbidden", 403);
    return summarizeEvents(process.env, { since: since || "1h" });
  }
}
