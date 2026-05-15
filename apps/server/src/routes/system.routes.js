import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSetupStatus } from "../../../../packages/core/src/setup.js";
import { publicConfig } from "../../../../packages/storage/src/config.js";
import { ensureDataDirs } from "../../../../packages/storage/src/paths.js";
import { listEvents } from "../../../../packages/storage/src/store.js";
import { eventsSchema } from "../../../../packages/shared/src/api-schemas.js";
import { json } from "../http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.resolve(__dirname, "../../../../package.json");

async function appVersion() {
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  return {
    name: pkg.name || "orkestr",
    version: pkg.version || "0.0.0",
  };
}

async function dataDirReady() {
  const paths = await ensureDataDirs();
  const probe = path.join(paths.home, ".ready-check");
  await fs.writeFile(probe, new Date().toISOString());
  await fs.unlink(probe).catch(() => {});
  return paths.home;
}

export async function registerSystemRoutes(app) {
  app.get("/api/health", async (_request, reply) => {
    return json(reply, 200, { ok: true, name: "orkestr", generatedAt: new Date().toISOString() });
  });

  app.get("/api/version", async (_request, reply) => {
    return json(reply, 200, { ...(await appVersion()), generatedAt: new Date().toISOString() });
  });

  app.get("/api/ready", async (_request, reply) => {
    const status = await getSetupStatus();
    return json(reply, 200, {
      ok: true,
      dataHome: await dataDirReady(),
      setupState: status.setupState,
      overlayValid: status.overlay.valid,
      generatedAt: new Date().toISOString(),
    });
  });

  app.get("/api/setup/status", async (_request, reply) => {
    return json(reply, 200, { ...(await getSetupStatus()), config: await publicConfig() });
  });

  app.get("/api/events", { schema: eventsSchema }, async (request, reply) => {
    return json(reply, 200, { events: await listEvents(process.env, Number(request.query.limit || 100)) });
  });
}
