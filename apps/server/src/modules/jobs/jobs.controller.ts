import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  listJobQueueForPrincipal,
  pauseJobsQueueForPrincipal,
  presentQueuedJobs,
  updateJobCandidateStateForPrincipal,
} from "../../../../../packages/core/src/jobs-queue.js";
import {
  createJobAlertRouteForPrincipal,
  ingestJobAlertEmail,
  listJobAlertRoutesForPrincipal,
  testJobAlertRouteForPrincipal,
} from "../../../../../packages/core/src/job-alerts.js";
import { createCalendarExport } from "../../../../../packages/core/src/calendar-export.js";
import { handleJobsJdCacheMcpRequest as handleJobsJdCacheMcp } from "../../../../../packages/core/src/jobs-jd-cache-mcp.js";
import { runGmailJobsPollForPrincipal } from "../../../../../packages/connectors/src/gmail-jobs-queue.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

@Controller("api/jobs")
export class JobsController {
  @Get("queue")
  async queue(@Req() request: any) {
    return listJobQueueForPrincipal(requestPrincipal(request));
  }

  @Get("jd-cache/mcp/health")
  async jdCacheMcpHealth(@Req() request: any) {
    const context = request.orkestrMachineAuthContext || {};
    return {
      ok: true,
      service: "jobs-jd-cache-mcp",
      machineAuth: request.orkestrMachineAuth || null,
      grant: context.grant || null,
    };
  }

  @Post("jd-cache/mcp")
  @HttpCode(200)
  async jdCacheMcp(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return handleJobsJdCacheMcp(body, request.orkestrMachineAuthContext || {}, process.env);
  }

  @Post("run")
  @HttpCode(200)
  async run(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return runGmailJobsPollForPrincipal(body, requestPrincipal(request));
  }

  @Get("alert-routes")
  async alertRoutes(@Req() request: any) {
    return listJobAlertRoutesForPrincipal(requestPrincipal(request));
  }

  @Post("alert-routes")
  @HttpCode(200)
  async createAlertRoute(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createJobAlertRouteForPrincipal(body, requestPrincipal(request));
  }

  @Post("alert-routes/:routeId/test")
  @HttpCode(200)
  async testAlertRoute(@Req() request: any, @Param("routeId") routeId: string) {
    return testJobAlertRouteForPrincipal(routeId, requestPrincipal(request));
  }

  @Post("inbound-email")
  @HttpCode(200)
  async inboundEmail(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    if (request.orkestrMachineAuth !== "job_alert_relay") {
      const error = new Error("job_alert_relay_auth_required");
      (error as any).statusCode = 403;
      throw error;
    }
    return ingestJobAlertEmail(body);
  }

  @Post("calendar-exports")
  @HttpCode(200)
  async calendarExport(@Body() body: Record<string, unknown> = {}) {
    return createCalendarExport(body);
  }

  @Post("present")
  @HttpCode(200)
  async present(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return presentQueuedJobs(body, process.env, { principal: requestPrincipal(request) });
  }

  @Post("pause")
  @HttpCode(200)
  async pause(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return pauseJobsQueueForPrincipal(body, requestPrincipal(request));
  }

  @Post(":candidateId/dismiss")
  @HttpCode(200)
  async dismiss(@Req() request: any, @Param("candidateId") candidateId: string) {
    return {
      candidate: await updateJobCandidateStateForPrincipal(candidateId, { state: "dismissed" }, requestPrincipal(request)),
    };
  }

  @Post(":candidateId/apply")
  @HttpCode(200)
  async apply(@Req() request: any, @Param("candidateId") candidateId: string) {
    return {
      candidate: await updateJobCandidateStateForPrincipal(candidateId, { applicationState: "started" }, requestPrincipal(request)),
    };
  }
}
