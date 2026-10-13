import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSetupStatus, publicSetupStatus } from "../packages/core/src/setup.js";

test("setup status tells the UI whether this install runs in Docker, also before pairing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-install-status-"));
  try {
    const docker = await getSetupStatus({ env: { ...process.env, ORKESTR_HOME: home, ORKESTR_DOCKER: "1" } });
    assert.deepEqual(docker.install, { docker: true });
    assert.deepEqual(publicSetupStatus(docker).install, { docker: true });
    const plain = await getSetupStatus({ env: { ...process.env, ORKESTR_HOME: home, ORKESTR_DOCKER: "" } });
    assert.deepEqual(publicSetupStatus(plain).install, { docker: false });
    assert.deepEqual(publicSetupStatus({}).install, { docker: false });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("pairing page shows the docker exec form of the approve command in Docker", async () => {
  const page = await fs.readFile("apps/web/src/app/pairing-required-page.component.ts", "utf8");
  assert.match(page, /isDocker\(\) \? `docker exec orkestr \$\{command\}` : command/);
  assert.match(page, /setupStatus\?\.install\?\.docker === true/);
});
