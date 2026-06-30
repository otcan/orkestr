import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  listJobQueueForPrincipal,
  pauseJobsQueueForPrincipal,
  presentQueuedJobs,
  updateJobCandidateStateForPrincipal,
} from "../../../../../packages/core/src/jobs-queue.js";
import { runGmailJobsPollForPrincipal } from "../../../../../packages/connectors/src/gmail-jobs-queue.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

@Controller("api/jobs")
export class JobsController {
  @Get("queue")
  async queue(@Req() request: any) {
    return listJobQueueForPrincipal(requestPrincipal(request));
  }

  @Post("run")
  @HttpCode(200)
  async run(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return runGmailJobsPollForPrincipal(body, requestPrincipal(request));
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
