import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { deployReleaseInstances, listReleaseInstances, publicReleaseInstance } from "../../../../../packages/core/src/release-instances.js";
import { appendEvent } from "../../../../../packages/storage/src/store.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

function enabledQuery(value: unknown): boolean {
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function requestedInstanceIds(body: Record<string, unknown> = {}): Set<string> {
  const raw = Array.isArray(body.instanceIds)
    ? body.instanceIds
    : Array.isArray(body.instances) ? body.instances : [];
  return new Set(raw.map((value) => clean(value)).filter(Boolean));
}

function principalUserId(request: any): string {
  const principal = requestPrincipal(request);
  return clean(principal?.userId || principal?.id || principal?.displayName || "admin") || "admin";
}

@Controller("api/release")
export class ReleaseController {
  @Get("instances")
  async instances(@Req() request: any, @Query("probe") probe: string) {
    assertAdminRequest(request);
    const instances = await listReleaseInstances(process.env, {
      probe: enabledQuery(probe),
      fetchImpl: globalThis.fetch,
    });
    const publicInstances = instances.map((instance) => publicReleaseInstance(instance));
    const counts = publicInstances.reduce((acc: Record<string, number>, instance) => {
      const key = instance.releaseTrainEnabled ? "releaseTrainEnabled" : "releaseTrainDisabled";
      acc[key] = (acc[key] || 0) + 1;
      if (instance.hasDeployCommand) acc.withDeployCommand = (acc.withDeployCommand || 0) + 1;
      const status = String(instance.status || "").trim().toLowerCase();
      if (["reachable", "running", "ready", "ok", "healthy"].includes(status)) acc.reachable = (acc.reachable || 0) + 1;
      if (["unreachable", "broken", "failed", "error", "down"].includes(status) || instance.lastError) acc.unreachable = (acc.unreachable || 0) + 1;
      const downtimeState = String(instance.downtime?.state || "").trim().toLowerCase();
      if (downtimeState === "up") acc.up = (acc.up || 0) + 1;
      if (downtimeState === "down") {
        acc.down = (acc.down || 0) + 1;
        acc.downtimeSeconds = (acc.downtimeSeconds || 0) + Number(instance.downtime?.durationSeconds || 0);
      }
      return acc;
    }, {});
    counts.total = publicInstances.length;
    counts.availabilityPercent = counts.total > 0
      ? Math.round(((counts.reachable || 0) / counts.total) * 1000) / 10
      : 100;
    return {
      instances: publicInstances,
      counts,
      generatedAt: new Date().toISOString(),
    };
  }

  @Post("instances/rollout")
  async rollout(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const execute = body.execute === true;
    if (execute && process.env.ORKESTR_RELEASE_UI_DEPLOY_ENABLED !== "1") {
      await appendEvent({
        type: "broker_release_rollout_blocked",
        action: "release.instances.rollout",
        outcome: "denied",
        resourceType: "release_instance",
        operatorUserId: principalUserId(request),
        ref: clean(body.ref) || process.env.ORKESTR_DEPLOY_REF || process.env.ORKESTR_UPDATE_REF || "main",
        channel: clean(body.channel) || process.env.ORKESTR_DEPLOY_CHANNEL || "production",
        requestedInstanceIds: [...requestedInstanceIds(body)],
        reason: "release_ui_execute_disabled",
      }).catch(() => null);
      throw httpError("release_ui_execute_disabled", 403);
    }
    const ids = requestedInstanceIds(body);
    const allInstances = await listReleaseInstances(process.env, { probe: false });
    const instances = ids.size
      ? allInstances.filter((instance) => ids.has(instance.id))
      : allInstances;
    const report = await deployReleaseInstances({
      instances,
      ref: clean(body.ref) || process.env.ORKESTR_DEPLOY_REF || process.env.ORKESTR_UPDATE_REF || "main",
      channel: clean(body.channel) || process.env.ORKESTR_DEPLOY_CHANNEL || "production",
      dryRun: !execute,
      skipLocal: body.skipLocal !== false,
      stdio: "pipe",
    }, process.env);
    await appendEvent({
      type: execute ? "broker_release_rollout_executed" : "broker_release_rollout_planned",
      action: "release.instances.rollout",
      outcome: report.ok === false ? "failed" : "success",
      resourceType: "release_instance",
      operatorUserId: principalUserId(request),
      ref: report.ref,
      channel: report.channel,
      dryRun: !execute,
      requestedInstanceIds: [...ids],
      matchedInstanceIds: instances.map((instance) => instance.id),
      counts: report.counts || {},
    }).catch(() => null);
    return {
      ...report,
      dryRun: !execute,
      execute,
      requestedInstanceIds: [...ids],
      matchedInstanceIds: instances.map((instance) => instance.id),
    };
  }
}
