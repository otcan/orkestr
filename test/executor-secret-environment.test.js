import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { commandEnv } from "../packages/core/src/codex-app-server-common.js";
import { claudeCodeRuntimeEnv } from "../packages/core/src/claude-code-environment.js";
import { codexAppServerProbe, codexLoginStatus, startCodexDeviceAuth } from "../packages/connectors/src/codex.js";

const exec = promisify(execFile);
const keys = ["ORKESTR_CONNECTOR_ENCRYPTION_KEY", "ORKESTR_SECRET_KEY", "ORKESTR_SECURE_INPUT_KEY"];
const sources = ["scripts/install.sh", "scripts/deploy-git-release.sh"];
const digest = text => createHash("sha256").update(text).digest("hex");

// All data is synthetic. Child receipts contain names and booleans, never env
// values; even an assertion failure cannot turn this probe into an env dump.
const probe = `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const keys = ${JSON.stringify(keys)};
const receipt = {
  leakedKeys: keys.filter(k => Object.hasOwn(process.env, k)),
  homePreserved: process.env.HOME === process.env.EXPECTED_HOME,
  authHomePreserved: process.env.CODEX_HOME === process.env.EXPECTED_CODEX_HOME,
  uidPreserved: String(process.getuid?.() ?? '') === process.env.EXPECTED_UID,
  providerAuthPreserved: process.env.OPENAI_API_KEY === 'synthetic-provider-auth',
};
fs.appendFileSync(process.env.PROBE_FILE, JSON.stringify(receipt) + '\\n');
if (process.argv.includes('stdio://')) {
  readline.createInterface({input: process.stdin}).on('line', line => {
    const input = JSON.parse(line);
    if (input.id) process.stdout.write(JSON.stringify({id: input.id, result: {}}) + '\\n');
  });
} else if (process.argv.includes('login')) {
  if (process.argv.includes('status') && process.env.PROBE_LOGIN_STATUS_FAIL === '1') process.exit(1);
  console.log('Logged in using ChatGPT');
}
else if (process.argv.includes('--version')) console.log('codex-test');
`;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-executor-env-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  const fake = path.join(bin, "fake-codex.mjs");
  await fs.writeFile(fake, probe, { mode: 0o755 });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    ORKESTR_HOME: path.join(dir, "state"),
    HOME: path.join(dir, "executor-home"),
    CODEX_HOME: path.join(dir, "canonical-auth"),
    ORKESTR_CODEX_BIN: fake,
    ORKESTR_CODEX_APP_SERVER_SOCKET: path.join(dir, "run", "codex.sock"),
    ORKESTR_CODEX_APP_SERVER_REFRESH_SETTLE_SECONDS: "0",
    ORKESTR_CODEX_APP_SERVER_REFRESH_ATTEMPTS: "1",
    ORKESTR_CODEX_APP_SERVER_SERVICE_NAME: "test-codex",
    OPENAI_API_KEY: "synthetic-provider-auth",
    PROBE_FILE: path.join(dir, "receipts.jsonl"),
    EXPECTED_UID: String(process.getuid?.() ?? ""),
    SYSTEMCTL_REPORT: path.join(dir, "systemctl.txt"),
    ...Object.fromEntries(keys.map(key => [key, `synthetic-${key}`])),
  };
  env.EXPECTED_HOME = env.HOME;
  env.EXPECTED_CODEX_HOME = env.CODEX_HOME;
  await fs.writeFile(path.join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$SYSTEMCTL_REPORT"\n', { mode: 0o755 });
  return { dir, bin, fake, env };
}

function generatedFunction(source, name) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  assert.ok(body, `generator ${name} exists`);
  // Execute the real generator in a disposable destination, never host paths.
  return body.replaceAll("/usr/local/bin/", '"$TEST_BIN"/')
    .replaceAll("/etc/systemd/system/", "$TEST_UNITS/");
}

async function receipts(env) {
  return (await fs.readFile(env.PROBE_FILE, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

function checkReceipts(rows, count) {
  assert.equal(rows.length, count);
  for (const row of rows) {
    assert.deepEqual(row.leakedKeys, []);
    assert.equal(row.homePreserved, true);
    assert.equal(row.authHomePreserved, true);
    assert.equal(row.uidPreserved, true);
    assert.equal(row.providerAuthPreserved, true);
  }
}

test("installer and deployer capability, login and MCP setup children keep keys only in their parent", { timeout: 10_000 }, async t => {
  const { env } = await fixture(t);
  for (const [index, source] of sources.entries()) {
    const text = await fs.readFile(source, "utf8");
    const functions = ["run_codex_command", "codex_command_supports_external_app_server"];
    if (index === 0) functions.push("codex_command_supports_app_server", "run_codex_login_if_requested", "configure_codex_interactively", "register_codex_connectors_mcp");
    const shell = [
      "set -eu",
      ...functions.map(name => generatedFunction(text, name)),
      'codex_command_supports_external_app_server "$ORKESTR_CODEX_BIN"',
      ...(index === 0 ? [
        'codex() { "$ORKESTR_CODEX_BIN" "$@"; }',
        "have() { :; }",
        "is_interactive_terminal() { :; }",
        "is_macos() { return 1; }",
        'prompt_yes_no() { printf -v "$1" "%s" 1; }',
        "configure_codex_interactively",
        'runuser() { test "$1" = -u && test "$2" = fixture-executor && test "$3" = -- || return 1; shift 3; "$@"; }',
        "env_file_value() { :; }", // No host config reads or identity changes.
        "register_codex_connectors_mcp",
      ] : []),
      ...keys.map(key => `test -n "\${${key}:-}"`),
    ].join("\n");
    await fs.writeFile(env.PROBE_FILE, "");
    await exec("bash", ["-c", shell], { env: {
      ...env, systemd: "0", PROBE_LOGIN_STATUS_FAIL: "1", run_user: "fixture-executor",
      ORKESTR_CONNECTORS_MCP_URL: "https://connectors.example.invalid",
    }, timeout: 5_000 });
    checkReceipts(await receipts(env), index === 0 ? 9 : 2);
  }
});

for (const fromFile of [false, true]) {
  test(`install then update regenerate safe Codex wrappers (${fromFile ? "env file" : "inherited env"})`, { timeout: 15_000 }, async t => {
    const { dir, bin, env } = await fixture(t);
    env.ORKESTR_ENV_FILE = path.join(dir, fromFile ? "control-plane.env" : "absent.env");
    const fileText = keys.map(key => `${key}=synthetic-file-${key}`).join("\n") + "\n";
    if (fromFile) await fs.writeFile(env.ORKESTR_ENV_FILE, fileText);
    for (const source of sources) {
      const text = await fs.readFile(source, "utf8");
      for (const [generator, target, count] of [
        ["write_codex_app_server_wrapper", "orkestr-codex-app-server", 1],
        ["write_codex_app_server_refresh_wrapper", "orkestr-refresh-codex-app-server", 2],
      ]) {
        const targetPath = path.join(bin, target);
        await fs.writeFile(targetPath, "old wrapper must be replaced\n");
        await exec("bash", ["-c", `${generatedFunction(text, generator)}\n${generator}`], {
          env: { PATH: process.env.PATH, TEST_BIN: bin }, timeout: 5_000,
        });
        await fs.writeFile(env.PROBE_FILE, "");
        await exec("bash", [targetPath], { env, timeout: 5_000 });
        checkReceipts(await receipts(env), count);
        assert.equal(keys.every(key => env[key] === `synthetic-${key}`), true, "control-plane env is unchanged");
        if (fromFile) assert.equal(digest(await fs.readFile(env.ORKESTR_ENV_FILE)), digest(fileText), "control-plane file is unchanged");
        if (count === 2) assert.equal(await fs.readFile(env.SYSTEMCTL_REPORT, "utf8"), "try-restart test-codex.service\n");
      }
    }
  });
}

test("generated Codex units filter keys without changing executor identity or control-plane units", { timeout: 10_000 }, async t => {
  const { dir, bin, fake } = await fixture(t);
  const units = path.join(dir, "units");
  await fs.mkdir(units);
  for (const [index, source] of sources.entries()) {
    const text = await fs.readFile(source, "utf8");
    const functions = index === 0
      ? ["write_systemd_codex_app_server_service", "write_systemd_codex_app_server_refresh_units"]
      : ["write_codex_app_server_systemd_service", "write_codex_app_server_refresh_units"];
    const shell = [
      "set -eu",
      "systemctl() { :; }", // No host systemd calls.
      'id() { printf "%s\\n" fixture-group; }',
      'runtime_run_user() { printf "%s\\n" fixture-executor; }',
      'codex_app_server_service_name() { printf "%s\\n" test-codex; }',
      ...functions.map(name => generatedFunction(text, name)),
      ...functions,
    ].join("\n");
    await exec("bash", ["-c", shell], { timeout: 5_000, env: {
      PATH: process.env.PATH, TEST_BIN: bin, TEST_UNITS: units,
      run_user: "fixture-executor", repo_dir: dir, deploy_root: dir,
      env_file: path.join(dir, "control-plane.env"), env_file_path: path.join(dir, "control-plane.env"),
      codex_app_server_service_name: "test-codex", ORKESTR_CODEX_BIN: fake,
    } });
    for (const name of ["test-codex", "test-codex-refresh"]) {
      const unit = await fs.readFile(path.join(units, `${name}.service`), "utf8");
      const unset = unit.split("\n").filter(line => line.startsWith("UnsetEnvironment="));
      assert.equal(unset.length, 1);
      assert.deepEqual(unset[0].slice("UnsetEnvironment=".length).split(" "), keys);
      if (name === "test-codex") {
        assert.equal(unit.includes("User=fixture-executor\n"), true);
        assert.equal(unit.includes("Group=fixture-group\n"), true);
      }
    }
    // Every UnsetEnvironment directive is confined to these two agent units.
    const unitBodies = [...text.matchAll(/<<EOF\n([\s\S]*?)\nEOF/g)].map(match => match[1]);
    const filtered = unitBodies.filter(body => body.includes("UnsetEnvironment="));
    assert.equal(filtered.length, 2);
    assert.equal(filtered.every(body => /ExecStart=\/usr\/local\/bin\/orkestr-(?:refresh-)?codex-app-server(?:\n|$)/.test(body)), true);
  }
});

test("direct Codex child processes drop control-plane keys and retain canonical auth", { timeout: 10_000 }, async t => {
  const { fake, env } = await fixture(t);
  const child = commandEnv(env);
  await exec(fake, [], { env: child, timeout: 3_000 });
  const stdio = { ...env, ORKESTR_CODEX_APP_SERVER_SOCKET: "", ORKESTR_CODEX_APP_SERVER_MODE: "stdio" };
  const result = await codexAppServerProbe({ env: stdio, timeoutMs: 2_000 });
  assert.equal(result.ok, true);
  assert.equal((await codexLoginStatus({ env })).connected, true);
  assert.equal((await startCodexDeviceAuth({ env, home: env.HOME })).state, "completed");
  // The same keys may arrive only through the control-plane process's ambient
  // env, even when a call's explicit overrides contain no keys at all.
  const moduleUrl = new URL("../packages/core/src/codex-app-server-common.js", import.meta.url).href;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
    import {execFileSync} from 'node:child_process';
    const {commandEnv} = await import(${JSON.stringify(moduleUrl)});
    const child = commandEnv({HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME});
    execFileSync(process.env.ORKESTR_CODEX_BIN, [], {env: child});
    console.log(JSON.stringify({parentRetainsKeys: ${JSON.stringify(keys)}.every(k => Object.hasOwn(process.env, k))}));
  `], { env, timeout: 3_000 });
  assert.equal(JSON.parse(stdout).parentRetainsKeys, true);
  checkReceipts(await receipts(env), 5);
  assert.equal(keys.every(key => env[key] === `synthetic-${key}`), true, "control plane retains its keys");
});

test("Claude worker and release-train children retain their allowlist with all master-key aliases present", { timeout: 10_000 }, async t => {
  const { dir, env } = await fixture(t);
  for (const thread of [{}, { agentReleaseRole: "release-train" }]) {
    const runtime = claudeCodeRuntimeEnv({ credentialRoot: path.join(dir, "profile") }, thread, env);
    const { stdout } = await exec(process.execPath, ["-e", `
      const keys = ${JSON.stringify(keys)};
      console.log(JSON.stringify({leakedKeys: keys.filter(k => Object.hasOwn(process.env, k)),
        profileSet: Boolean(process.env.CLAUDE_CONFIG_DIR),
        uidPreserved: process.getuid?.() === ${JSON.stringify(process.getuid?.())}}));
    `], { env: runtime, timeout: 3_000 });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.leakedKeys, []);
    assert.equal(result.profileSet, true);
    assert.equal(result.uidPreserved, true);
  }
  assert.equal(keys.every(key => env[key] === `synthetic-${key}`), true);
});
