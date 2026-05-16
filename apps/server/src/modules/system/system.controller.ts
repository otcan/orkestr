import fs from "node:fs/promises";
import path from "node:path";
import { Controller, Get, Query } from "@nestjs/common";
import { listRuntimeLeases } from "../../../../../packages/core/src/runtime-leases.js";
import { getSetupStatus } from "../../../../../packages/core/src/setup.js";
import { publicConfig } from "../../../../../packages/storage/src/config.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { listEvents } from "../../../../../packages/storage/src/store.js";

@Controller("api")
export class SystemController {
  @Get("health")
  health() {
    return { ok: true, name: "orkestr", generatedAt: new Date().toISOString() };
  }

  @Get("version")
  async version() {
    const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    return {
      name: pkg.name || "orkestr",
      version: pkg.version || "0.0.0",
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("ready")
  async ready() {
    const status = await getSetupStatus();
    return {
      ok: true,
      dataHome: await this.dataDirReady(),
      setupState: status.setupState,
      overlayValid: status.overlay.valid,
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("setup/status")
  async setupStatus() {
    return { ...(await getSetupStatus()), config: await publicConfig() };
  }

  @Get("events")
  async events(@Query("limit") limit = "100") {
    return { events: await listEvents(process.env, Number(limit || 100)) };
  }

  @Get("runtime-leases")
  async runtimeLeases() {
    return { leases: await listRuntimeLeases(), budget: { maxLiveThreads: Number(process.env.ORKESTR_MAX_LIVE_THREADS || 20) } };
  }

  private async dataDirReady() {
    const paths = await ensureDataDirs();
    const probe = path.join(paths.home, ".ready-check");
    await fs.writeFile(probe, new Date().toISOString());
    await fs.unlink(probe).catch(() => {});
    return paths.home;
  }
}
