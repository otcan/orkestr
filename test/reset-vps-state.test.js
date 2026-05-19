import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function exists(filePath) {
  return fs.stat(filePath).then(() => true, () => false);
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function resetEnv(paths, extra = {}) {
  return {
    ...process.env,
    ORKESTR_ENV_FILE: paths.envFile,
    ORKESTR_HOME: paths.home,
    ORKESTR_RUNTIME_WORKSPACE_ROOT: paths.workspace,
    ORKESTR_OVERLAY_DIR: paths.overlay,
    ORKESTR_APP_DIR: paths.app,
    ORKESTR_RUN_USER: os.userInfo().username,
    ORKESTR_RESET_KILL_TMUX: "0",
    ORKESTR_RESET_ALLOW_ANY_PATH: "1",
    ORKESTR_RESET_SKIP_CODEX_LOGIN: "1",
    ...extra,
  };
}

async function createResetFixture() {
  const envDir = await tempDir("orkestr-reset-env-");
  const paths = {
    envFile: path.join(envDir, "orkestr.env"),
    home: await tempDir("orkestr-reset-home-"),
    workspace: await tempDir("orkestr-reset-workspace-"),
    overlay: await tempDir("orkestr-reset-overlay-"),
    app: await tempDir("orkestr-reset-app-"),
  };
  await fs.writeFile(paths.envFile, "ORKESTR_PORT=19812\n", "utf8");
  await fs.writeFile(path.join(paths.home, "threads.json"), "[]\n", "utf8");
  await fs.writeFile(path.join(paths.workspace, "old-work.txt"), "old\n", "utf8");
  await fs.writeFile(path.join(paths.overlay, "overlay.json"), "{}\n", "utf8");
  return paths;
}

test("reset VPS state clears data and workspace while preserving env and overlay by default", async () => {
  const paths = await createResetFixture();

  await execFileAsync("bash", ["-n", "scripts/reset-vps-state.sh"]);
  await execFileAsync("bash", ["scripts/reset-vps-state.sh", "--no-stop-service"], {
    env: resetEnv(paths),
  });

  assert.equal(await exists(paths.envFile), true);
  assert.equal(await exists(path.join(paths.home, "threads.json")), false);
  assert.equal(await exists(path.join(paths.workspace, "old-work.txt")), false);
  assert.equal(await exists(path.join(paths.overlay, "overlay.json")), true);
  assert.equal(await exists(paths.home), true);
  assert.equal(await exists(paths.workspace), true);
});

test("reset VPS state clears overlay only when explicitly enabled", async () => {
  const paths = await createResetFixture();

  await execFileAsync("bash", ["scripts/reset-vps-state.sh", "--no-stop-service"], {
    env: resetEnv(paths, { ORKESTR_RESET_OVERLAY: "1" }),
  });

  assert.equal(await exists(paths.envFile), true);
  assert.equal(await exists(path.join(paths.overlay, "overlay.json")), false);
  assert.equal(await exists(paths.overlay), true);
});

test("reset VPS state refuses dangerous paths", async () => {
  const paths = await createResetFixture();

  await assert.rejects(
    execFileAsync("bash", ["scripts/reset-vps-state.sh", "--check-only"], {
      env: resetEnv(paths, { ORKESTR_HOME: "/" }),
    }),
    /unsafe path/,
  );
});
