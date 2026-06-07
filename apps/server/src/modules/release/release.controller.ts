import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { deployReleaseInstances, listReleaseInstances, publicReleaseInstance } from "../../../../../packages/core/src/release-instances.js";
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
      return acc;
    }, {});
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
    return {
      ...report,
      dryRun: !execute,
      execute,
      requestedInstanceIds: [...ids],
      matchedInstanceIds: instances.map((instance) => instance.id),
    };
  }
}
