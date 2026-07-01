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

test("system doctor warns when active URL drop-ins mix public and private instances", async () => {
  const { home, env } = await fakeHost();
  const dropInDir = path.join(home, "dropins");
  const publicDropIn = path.join(dropInDir, "70-orkestr-de-public-urls.conf");
  const privateDropIn = path.join(dropInDir, "71-private-ops-urls.conf");
  const privatePairingDropIn = path.join(dropInDir, "72-private-pairing-url.conf");
  await fs.mkdir(dropInDir, { recursive: true });
  await fs.writeFile(publicDropIn, [
    "[Service]",
    "Environment=ORKESTR_PRIMARY_DOMAIN=orkestr.example.test",
    "Environment=ORKESTR_APP_HOST=app.orkestr.example.test",
    "Environment=ORKESTR_AUTH_HOST=auth.orkestr.example.test",
    "Environment=ORKESTR_PUBLIC_APP_URL=https://app.orkestr.example.test",
    "Environment=ORKESTR_AUTH_URL=https://auth.orkestr.example.test",
    "",
  ].join("\n"));
  await fs.writeFile(privateDropIn, [
    "[Service]",
    "Environment=ORKESTR_PRIMARY_DOMAIN=ops.example.test",
    "Environment=ORKESTR_APP_HOST=orkestr.app.ops.example.test",
    "Environment=ORKESTR_AUTH_HOST=auth.ops.example.test",
    "Environment=ORKESTR_PUBLIC_SITE_URL=https://orkestr.example.test",
    "Environment=ORKESTR_PUBLIC_APP_URL=https://orkestr.app.ops.example.test",
    "Environment=ORKESTR_AUTH_URL=https://auth.ops.example.test",
    "",
  ].join("\n"));
  await fs.writeFile(privatePairingDropIn, [
    "[Service]",
    "Environment=ORKESTR_PAIRING_URL=https://orkestr.app.ops.example.test/setup/pairing",
    "",
  ].join("\n"));

  const doctor = await systemDoctor({
    env: {
      ...env,
      ORKESTR_SYSTEMD_DROPIN_PATHS: `${publicDropIn} ${privateDropIn} ${privatePairingDropIn}`,
      ORKESTR_PRIMARY_DOMAIN: "ops.example.test",
      ORKESTR_APP_HOST: "orkestr.app.ops.example.test",
      ORKESTR_AUTH_HOST: "auth.ops.example.test",
      ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example.test",
      ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
      ORKESTR_AUTH_URL: "https://auth.ops.example.test",
    },
    home,
  });
  const effective = doctor.checks.find((check) => check.id === "public_url_identity");
  const dropIns = doctor.checks.find((check) => check.id === "public_url_dropins");

  assert.equal(effective?.status, "ok");
  assert.equal(dropIns?.status, "warning");
  assert.deepEqual((dropIns?.roots || []).map((root) => root.root), ["ops.example.test", "orkestr.example.test"]);
  assert.match(dropIns?.summary || "", /example\.test/);
  assert.match(dropIns?.summary || "", /ops\.example\.test/);
  assert.ok(doctor.issues.some((issue) => issue.code === "public_url_dropins"));
});

test("system doctor allows role-specific public auth and connect drop-ins", async () => {
  const { home, env } = await fakeHost();
  const dropInDir = path.join(home, "dropins");
  const privateDropIn = path.join(dropInDir, "71-private-ops-urls.conf");
  const publicAuthDropIn = path.join(dropInDir, "76-public-auth-url.conf");
  const connectDropIn = path.join(dropInDir, "73-connect-public-url.conf");
  await fs.mkdir(dropInDir, { recursive: true });
  await fs.writeFile(privateDropIn, [
    "[Service]",
    "Environment=ORKESTR_PRIMARY_DOMAIN=ops.example.test",
    "Environment=ORKESTR_APP_HOST=orkestr.app.ops.example.test",
    "Environment=ORKESTR_AUTH_HOST=auth.ops.example.test",
    "Environment=ORKESTR_PUBLIC_APP_URL=https://orkestr.app.ops.example.test",
    "Environment=ORKESTR_AUTH_URL=https://auth.ops.example.test",
    "",
  ].join("\n"));
  await fs.writeFile(publicAuthDropIn, [
    "[Service]",
    "Environment=ORKESTR_PUBLIC_AUTH_URL=https://connect.orkestr.example/setup/pairing",
    "",
  ].join("\n"));
  await fs.writeFile(connectDropIn, [
    "[Service]",
    "Environment=ORKESTR_CONNECT_PUBLIC_URL=https://connect.crawler.example",
    "",
  ].join("\n"));

  const doctor = await systemDoctor({
    env: {
      ...env,
      ORKESTR_SYSTEMD_DROPIN_PATHS: `${privateDropIn} ${publicAuthDropIn} ${connectDropIn}`,
      ORKESTR_PRIMARY_DOMAIN: "ops.example.test",
      ORKESTR_APP_HOST: "orkestr.app.ops.example.test",
      ORKESTR_AUTH_HOST: "auth.ops.example.test",
      ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
      ORKESTR_AUTH_URL: "https://auth.ops.example.test",
      ORKESTR_PUBLIC_AUTH_URL: "https://connect.orkestr.example/setup/pairing",
      ORKESTR_CONNECT_PUBLIC_URL: "https://connect.crawler.example",
    },
    home,
  });
  const effective = doctor.checks.find((check) => check.id === "public_url_identity");
  const dropIns = doctor.checks.find((check) => check.id === "public_url_dropins");

  assert.equal(effective?.status, "ok");
  assert.equal(dropIns?.status, "ok");
  assert.deepEqual((dropIns?.roots || []).map((root) => root.root), ["ops.example.test"]);
  assert.equal(doctor.issues.some((issue) => issue.code === "public_url_identity"), false);
  assert.equal(doctor.issues.some((issue) => issue.code === "public_url_dropins"), false);
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
