import { Controller, Get, Query, Req } from "@nestjs/common";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { listReleaseInstances, publicReleaseInstance } from "../../../../../packages/core/src/release-instances.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

function enabledQuery(value: unknown): boolean {
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
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
}
