import { Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { defaultSetupDeps, installSetup, setupStatus, uninstallSetup } from "../../../../../packages/core/src/setups/setup-installer.js";
import { configureSetup, exportSetup, pauseSetup, resumeSetup } from "../../../../../packages/core/src/setups/setup-configure.js";
import { listSetupManifests, setupManifestSummary } from "../../../../../packages/core/src/setups/setup-registry.js";
import { httpError } from "../../common/http.js";
import { setupProviderReady } from "./setup-provider-readiness.js";

const deps = { ...defaultSetupDeps, providerReady: setupProviderReady };

// Preview Setup packages. Admin only until the non-admin path has its own
// sanitizer review; install never binds WhatsApp.
function assertAdmin(request: any, action: string) {
  if (!isAdminPrincipal(requestPrincipal(request))) throw httpError(`${action}_admin_only`, 403);
}

function rethrow(error: any, fallback: string): never {
  const extra: Record<string, unknown> = {};
  for (const key of ["checked", "missing", "rollback", "instanceId", "existingThreadId", "allowed", "unknown", "conflict"]) {
    if (error?.[key] !== undefined) extra[key] = error[key];
  }
  throw httpError(error?.code || error?.message || fallback, error?.statusCode || 400, extra);
}

function keyList(value: unknown): string[] {
  return (Array.isArray(value) ? value : String(value || "").split(",")).map((key) => String(key).trim()).filter(Boolean);
}

@Controller("api/setups")
export class SetupsController {
  @Get()
  list(@Req() request: any) {
    assertAdmin(request, "setup.list");
    return { setups: listSetupManifests().map(setupManifestSummary) };
  }

  @Get("status")
  async status(@Req() request: any, @Query("setupId") setupId = "", @Query("ownerUserId") ownerUserId = "") {
    assertAdmin(request, "setup.status");
    return { instances: await setupStatus({ setupId, ownerUserId }, process.env, deps) };
  }

  @Post(":setupId/install")
  async install(@Req() request: any, @Param("setupId") setupId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdmin(request, "setup.install");
    try {
      return await installSetup({
        setupId,
        ownerUserId: String(body.ownerUserId || ""),
        provider: String(body.provider || ""),
        timezone: String(body.timezone || ""),
        optIn: keyList(body.optIn),
      }, process.env, deps);
    } catch (error) {
      rethrow(error, "setup_install_failed");
    }
  }

  @Post(":setupId/configure")
  async configure(@Req() request: any, @Param("setupId") setupId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdmin(request, "setup.configure");
    try {
      return await configureSetup({ setupId, ownerUserId: String(body.ownerUserId || ""), enable: keyList(body.enable), disable: keyList(body.disable) }, process.env, deps);
    } catch (error) {
      rethrow(error, "setup_configure_failed");
    }
  }

  @Post(":setupId/pause")
  async pause(@Req() request: any, @Param("setupId") setupId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdmin(request, "setup.pause");
    try {
      return await pauseSetup({ setupId, ownerUserId: String(body.ownerUserId || "") }, process.env, deps);
    } catch (error) {
      rethrow(error, "setup_pause_failed");
    }
  }

  @Post(":setupId/resume")
  async resume(@Req() request: any, @Param("setupId") setupId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdmin(request, "setup.resume");
    try {
      return await resumeSetup({ setupId, ownerUserId: String(body.ownerUserId || "") }, process.env, deps);
    } catch (error) {
      rethrow(error, "setup_resume_failed");
    }
  }

  @Get(":setupId/export")
  async export(@Req() request: any, @Param("setupId") setupId: string, @Query("ownerUserId") ownerUserId = "") {
    assertAdmin(request, "setup.export");
    try {
      return await exportSetup({ setupId, ownerUserId }, process.env, deps);
    } catch (error) {
      rethrow(error, "setup_export_failed");
    }
  }

  @Delete(":setupId")
  async uninstall(@Req() request: any, @Param("setupId") setupId: string, @Query("ownerUserId") ownerUserId = "") {
    assertAdmin(request, "setup.uninstall");
    try {
      return await uninstallSetup({ setupId, ownerUserId }, process.env, deps);
    } catch (error) {
      rethrow(error, "setup_uninstall_failed");
    }
  }
}
