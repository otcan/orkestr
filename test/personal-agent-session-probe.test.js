import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeInstalledSessions } from "../scripts/personal-agent-session-probe.mjs";

async function fakeCodex(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-probe-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = path.join(root, "calls.jsonl");
  const bin = path.join(root, "codex");
  await fs.writeFile(bin, `#!${process.execPath}\n` + `
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({version:process.argv[2] === "--version",schema:process.argv.includes("generate-json-schema"),appServer:process.argv[2] === "app-server",auth:process.argv.includes("auth"),login:process.argv.includes("login"),status:process.argv.includes("status"),disposableHome:process.env.HOME !== ${JSON.stringify(root)},isolatedCodexHome:process.env.CODEX_HOME === path.join(process.env.HOME,"codex"),disposableCwd:process.cwd() === process.env.HOME,relativeMarkerReachable:fs.existsSync("caller-workspace-marker"),inherited:Object.fromEntries(["CLAUDE_CONFIG_DIR","CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","ORKESTR_CANARY_SECRET"].map(key => [key,key in process.env]))}) + "\\n");
if (process.argv[2] === "--version") console.log("codex-cli 0.163.0");
else if (process.argv[2] === "login") console.log("Logged in using ChatGPT");
else if (process.argv.includes("generate-json-schema")) {
  const dir = path.join(process.argv[process.argv.indexOf("--out") + 1], "v2");
  fs.mkdirSync(dir, {recursive:true});
  for (const name of ["ThreadStart", "ThreadResume", "ThreadFork", "TurnSteer", "TurnInterrupt", "TurnStart", "ThreadSettingsUpdate"])
    fs.writeFileSync(path.join(dir, name + "Params.json"), JSON.stringify({properties:{threadId:{}}}));
} else {
  let id = 0;
  readline.createInterface({input:process.stdin}).on("line", line => {
    const q = JSON.parse(line);
    if (q.id == null) return;
    const result = q.method === "thread/start" ? {thread:{id:"synthetic-" + ++id}} : {};
    console.log(JSON.stringify({id:q.id, result}));
  });
}
`, { mode: 0o755 });
  return { root, bin, calls: async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}

for (const configuredWrapper of [true, false]) {
  test(`inventory never executes a Claude ${configuredWrapper ? "configured wrapper" : "PATH fallback"} or touches its ambient profile`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-probe-fixture-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = path.join(root, "calls.jsonl");
    const profile = path.join(root, "synthetic-profile");
    await fs.mkdir(profile);
    const marker = path.join(profile, "wrapper-side-effect");
    const bin = path.join(root, "claude");
    // Synthetic stand-in for a wrapper with side effects even on --version.
    await fs.writeFile(bin, `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({called:true,auth:process.argv.includes("auth"),status:process.argv.includes("status")}) + "\\n");\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, "synthetic side effect");\n` +
      `console.log(process.argv[2] === "auth" ? JSON.stringify({authMethod:"subscription_token",loggedIn:true}) : "2.1.295 --resume --fork-session --session-id --model --effort --output-format");\n`, { mode: 0o755 });
    const result = await probeInstalledSessions({
      PATH: root,
      HOME: root,
      ORKESTR_CODEX_BIN: path.join(root, "missing-codex"),
      ...(configuredWrapper ? { ORKESTR_CLAUDE_CODE_BIN: bin } : {}),
      CLAUDE_CONFIG_DIR: profile,
    });
    const observed = (await fs.readFile(calls, "utf8").catch(() => "")).trim();
    assert.equal(observed.length, 0, "metadata inventory must never dispatch a profile-aware Claude command");
    assert.equal(await fs.stat(marker).then(() => true, () => false), false, "profile left untouched");
    assert.equal(result.claude.blocked, "manual_metadata_verification_required");
    assert.deepEqual(result.claude.auth, { verified: false });
    assert.equal(result.inferenceTurns, 0);
  });
}

test("Codex inventory never falls back to a configured wrapper or live login status", async t => {
  const fixture = await fakeCodex(t);
  const profile = path.join(fixture.root, "live-profile");
  const result = await probeInstalledSessions({ PATH: fixture.root, HOME: fixture.root,
    ORKESTR_CODEX_BIN: fixture.bin, CODEX_HOME: profile });
  assert.equal((await fixture.calls()).length, 0, "configured Codex wrappers must never execute");
  assert.equal(await fs.stat(profile).then(() => true, () => false), false, "live home must not be created");
  assert.equal(result.codex.blocked, "direct_binary_required");
  assert.deepEqual(result.codex.auth, { verified: false });
});

test("explicit direct Codex metadata calls use disposable home/cwd and sanitized child env", async t => {
  const fixture = await fakeCodex(t);
  await fs.writeFile(path.join(fixture.root, "caller-workspace-marker"), "synthetic");
  // Run the script as a child so ambient process.env leakage from the real
  // app-server client's commandEnv is exercised without mutating the test host.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("../scripts/personal-agent-session-probe.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, "--run-no-inference", "--codex-bin", fixture.bin], {
    cwd: fixture.root,
    env: { PATH: process.env.PATH, HOME: fixture.root, CODEX_HOME: path.join(fixture.root, "live-profile"),
      CLAUDE_CONFIG_DIR: path.join(fixture.root, "live-claude"), CLAUDE_CODE_OAUTH_TOKEN: "synthetic-only",
      OPENAI_API_KEY: "synthetic-only", ORKESTR_CANARY_SECRET: "synthetic-only" },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.codex.blocked, undefined);
  assert.deepEqual(result.codex.auth, { verified: false });
  const calls = await fixture.calls();
  assert.equal(calls.length, 3, "only version, schema generation and isolated app-server");
  for (const { auth, login, status, disposableHome, isolatedCodexHome, disposableCwd, relativeMarkerReachable, inherited } of calls) {
    assert.equal(auth || login || status, false);
    assert.equal(disposableHome, true);
    assert.equal(isolatedCodexHome, true);
    assert.equal(disposableCwd, true, "every command including app-server must launch in disposable cwd");
    assert.equal(relativeMarkerReachable, false, "caller relative marker must be unreachable");
    for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "ORKESTR_CANARY_SECRET"])
      assert.equal(inherited[key], false, `${key} must not reach any child, including app-server`);
  }
  assert.equal(await fs.stat(path.join(fixture.root, "live-profile")).then(() => true, () => false), false);
});

test("shared app-server client keeps the caller cwd when no launch cwd is supplied", async t => {
  const fixture = await fakeCodex(t);
  await fs.writeFile(path.join(fixture.root, "caller-workspace-marker"), "synthetic");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const clientUrl = new URL("../packages/core/src/codex-job-client.js", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { CodexJobClient } from ${JSON.stringify(clientUrl)};
    import { once } from "node:events";
    const client = new CodexJobClient({env:process.env,home:process.env.HOME});
    try { await client.start(); }
    finally {
      const stopped = once(client.proc, "close");
      client.close();
      await stopped;
    }
  `], {
    cwd: fixture.root,
    env: { PATH: process.env.PATH, HOME: fixture.root, ORKESTR_CODEX_BIN: fixture.bin,
      ORKESTR_CODEX_APP_SERVER_MODE: "stdio", ORKESTR_CODEX_APP_SERVER_TIMEOUT_MS: "1000" },
    timeout: 5000,
  });
  const calls = await fixture.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].appServer, true);
  assert.equal(calls[0].disposableCwd, true, "no cwd option must preserve inherited cwd");
  assert.equal(calls[0].relativeMarkerReachable, true, "synthetic caller cwd remains visible by default");
});
