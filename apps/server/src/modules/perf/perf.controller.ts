import { Controller, Get, Query, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { perfSummary } from "../../../../../packages/core/src/perf-summary.js";
import { httpError } from "../../common/http.js";

// Request latency and host/server health from the perf log, for
// `orkestr doctor perf`. Admin only.
@Controller("api/system")
export class PerfController {
  @Get("perf")
  async perf(@Req() request: any, @Query("window") window?: string) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("forbidden", 403);
    return perfSummary(process.env, { window: window || "1h" });
  }
}
