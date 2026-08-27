import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listLauncherApps, normalizeLauncherApp } from "../packages/core/src/app-launcher.js";
import { adminPrincipal } from "../packages/core/src/principal.js";

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "orkestr-app-launcher-"));
}

async function withServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("app launcher exposes generic defaults only", async () => {
  const env = { ORKESTR_HOME: await tempHome() };
  const result = await listLauncherApps({ env });
  assert.equal(result.ok, true);
  assert.ok(result.apps.some((app) => app.slug === "desktops"));
  assert.ok(result.apps.every((app) => !String(app.url).includes("@")));
  assert.ok(result.apps.every((app) => !("healthUrl" in app)));
});

test("app launcher accepts runtime, env, and file entries without leaking probe URLs", async () => {
  const home = await tempHome();
  const launcherFile = path.join(home, "launcher.json");
  await fs.writeFile(path.join(home, "runtime-settings.json"), JSON.stringify({
    appLauncher: {
      items: [{
        id: "runtime-tool",
        label: "Runtime Tool",
        url: "https://runtime.example.test/",
        healthUrl: "https://health.example.test/status",
        tags: ["runtime", "ops"],
      }],
    },
  }));
  await fs.writeFile(launcherFile, JSON.stringify({
    apps: [{
      id: "file-tool",
      label: "File Tool",
      url: "/tools/file",
      type: "ops",
    }],
  }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_APP_LAUNCHER_FILE: launcherFile,
    ORKESTR_APP_LAUNCHER_JSON: JSON.stringify([{ id: "env-tool", url: "https://env.example.test/" }]),
  };
  const result = await listLauncherApps({ env });
  const slugs = result.apps.map((app) => app.slug).sort();
  assert.ok(slugs.includes("runtime-tool"));
  assert.ok(slugs.includes("file-tool"));
  assert.ok(slugs.includes("env-tool"));
  assert.equal(result.apps.find((app) => app.slug === "runtime-tool").healthUrl, undefined);
});

test("app launcher filters unsafe and admin-only entries for normal users", async () => {
  assert.equal(normalizeLauncherApp({ id: "bad-js", url: "javascript:alert(1)" }), null);
  assert.equal(normalizeLauncherApp({ id: "bad-credentials", url: "https://user:pass@example.test" }), null);
  const env = {
    ORKESTR_HOME: await tempHome(),
    ORKESTR_APP_LAUNCHER_JSON: JSON.stringify([
      { id: "public-tool", url: "/public" },
      { id: "admin-tool", url: "/admin", adminOnly: true },
    ]),
  };
  const normal = await listLauncherApps({ env, principal: { role: "user" } });
  assert.ok(normal.apps.some((app) => app.slug === "public-tool"));
  assert.ok(!normal.apps.some((app) => app.slug === "admin-tool"));
  const admin = await listLauncherApps({ env, principal: adminPrincipal({ id: "admin" }) });
  assert.ok(admin.apps.some((app) => app.slug === "admin-tool"));
});

test("app launcher health checks are bounded and summarized", async () => {
  const server = await withServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  try {
    const env = {
      ORKESTR_HOME: await tempHome(),
      ORKESTR_APP_LAUNCHER_DEFAULTS: "0",
      ORKESTR_APP_LAUNCHER_JSON: JSON.stringify([{ id: "healthy", url: "/healthy", healthUrl: `${server.url}/health` }]),
    };
    const result = await listLauncherApps({ env, includeHealth: true });
    assert.equal(result.apps.length, 1);
    assert.equal(result.apps[0].health.status, "ok");
    assert.equal(result.apps[0].health.statusCode, 204);
    assert.equal(result.counts.available, 1);
  } finally {
    await server.close();
  }
});
