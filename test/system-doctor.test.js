import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { systemDoctor } from "../packages/core/src/system-doctor.js";

async function writeCommand(binDir, name, body) {
  const file = path.join(binDir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
  await fs.chmod(file, 0o755);
}

async function fakeHost({ omit = [] } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-system-doctor-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  const commands = {
    git: "echo 'git version 2.45.0'",
    tmux: "echo 'tmux 3.4'",
    rg: "echo 'ripgrep 14.1.0'",
    npm: "echo '10.8.0'",
    chromium: "echo 'Chromium 124.0.0'",
    codex: "if [ \"$1\" = 'login' ] && [ \"$2\" = 'status' ]; then echo 'Logged in with API key'; exit 0; fi\necho 'codex test'",
    caddy: "echo 'v2.8.4'",
    tailscale: "echo '{\"Self\":{\"HostName\":\"orkestr\"}}'",
  };
  for (const [name, body] of Object.entries(commands)) {
    if (!omit.includes(name)) await writeCommand(bin, name, body);
  }
  const env = {
    ORKESTR_HOME: path.join(home, "data"),
    HOME: path.join(home, "user"),
    PATH: bin,
    ORKESTR_HOST: "127.0.0.1",
    ORKESTR_SECURITY_COMMAND_CACHE_TTL_MS: "0",
  };
  return { home, env };
}

test("system doctor reports a healthy host when required commands and paths are available", async () => {
  const { home, env } = await fakeHost();
  const doctor = await systemDoctor({ env, home });

  assert.equal(doctor.status, "ok");
  assert.equal(doctor.ok, true);
  assert.equal(doctor.counts.errors, 0);
  assert.equal(doctor.checks.find((check) => check.id === "codex")?.status, "ok");
  assert.equal(doctor.checks.find((check) => check.id === "browser")?.command, "chromium");
  assert.equal(doctor.paths.home, env.ORKESTR_HOME);
});

test("system doctor reports missing required host tools as errors", async () => {
  const { home, env } = await fakeHost({ omit: ["tmux"] });
  const doctor = await systemDoctor({ env, home });
  const tmux = doctor.checks.find((check) => check.id === "tmux");

  assert.equal(doctor.status, "broken");
  assert.equal(doctor.ok, false);
  assert.equal(tmux?.status, "error");
  assert.match(tmux?.summary || "", /tmux is not available/);
  assert.ok(doctor.issues.some((issue) => issue.code === "tmux"));
});
