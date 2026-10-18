// Opt-in installed-runtime control-plane probe. NEVER starts a model turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { CodexJobClient } from "../packages/core/src/codex-job-client.js";
import { codexCommand, codexLoginStatus } from "../packages/connectors/src/codex.js";
import { claudeCodeCommand } from "../packages/core/src/claude-code-client.js";
import { claudeCodeStatusAuthenticated } from "../packages/core/src/claude-code-auth-status.js";

const exec = promisify(execFile);
const options = { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 };
const safeVersion = value => String(value || "").match(/(?:codex-cli\s+)?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*/)?.[0] || "unknown";

export async function probeInstalledSessions(env = process.env) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-probe-"));
  const codexBin = codexCommand(env);
  const claudeBin = claudeCodeCommand(env);
  const result = { inferenceTurns: 0, codex: {}, claude: {} };
  let client;
  try {
    try {
      const version = await exec(codexBin, ["--version"], { ...options, env });
      result.codex.version = safeVersion(version.stdout);
      const status = await codexLoginStatus({ env });
      result.codex.auth = { authenticated: status.connected, subscription: status.authMode === "chatgpt", reason: status.reason };
      // The app-server uses an empty disposable home, NOT the host profile.
      const isolated = { PATH: env.PATH || process.env.PATH, HOME: temporary, CODEX_HOME: path.join(temporary, "codex"),
        ORKESTR_CODEX_BIN: codexBin, ORKESTR_CODEX_APP_SERVER_MODE: "stdio", ORKESTR_CODEX_APP_SERVER_SOCKET: "",
        ORKESTR_CODEX_APP_SERVER_TIMEOUT_MS: "10000", OPENAI_API_KEY: "", CODEX_API_KEY: "" };
      await fs.mkdir(isolated.CODEX_HOME, { recursive: true });
      const schemas = path.join(temporary, "schemas");
      await exec(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", schemas], { ...options, env: isolated });
      result.codex.protocol = {};
      for (const name of ["ThreadStart", "ThreadResume", "ThreadFork", "TurnSteer", "TurnInterrupt", "TurnStart", "ThreadSettingsUpdate"]) {
        const schema = JSON.parse(await fs.readFile(path.join(schemas, "v2", `${name}Params.json`), "utf8"));
        result.codex.protocol[name] = Object.keys(schema.properties || {});
      }
      client = new CodexJobClient({ env: isolated, home: temporary });
      await client.start();
      // Reject inference methods before they can reach the installed runtime.
      const allowed = new Set(["thread/start", "thread/resume", "thread/fork", "thread/read", "thread/settings/update", "turn/steer", "turn/interrupt"]);
      result.codex.controlRequests = {};
      const request = client.request.bind(client);
      client.request = (method, body) => {
        if (!allowed.has(method)) throw new Error("inference_probe_forbidden");
        result.codex.controlRequests[method] = (result.codex.controlRequests[method] || 0) + 1;
        return request(method, body);
      };
      const params = { cwd: temporary, model: "gpt-6-sol", approvalPolicy: "untrusted", sandbox: "read-only", ephemeral: false, allowProviderModelFallback: false };
      const [fast, deep] = await Promise.all([client.request("thread/start", params), client.request("thread/start", params)]);
      result.codex.distinctNativeIds = Boolean(fast.thread.id && deep.thread.id && fast.thread.id !== deep.thread.id);
      const check = async (name, body) => {
        try {
          const value = await client.request(name, body);
          return { accepted: true, ...(value.thread?.id ? { sameNativeId: value.thread.id === fast.thread.id } : {}) };
        }
        catch (error) { return { accepted: false, rpcCode: typeof error.code === "number" ? error.code : null,
          emptyHistory: /no rollout|not found|empty|not materialized|no history/i.test(String(error.message)) }; }
      };
      result.codex.emptyResume = await check("thread/resume", { threadId: fast.thread.id });
      result.codex.emptyFork = await check("thread/fork", { threadId: fast.thread.id });
      result.codex.idleSteer = await check("turn/steer", { threadId: fast.thread.id, expectedTurnId: "synthetic-idle-turn", input: [{ type: "text", text: "synthetic control probe" }] });
      result.codex.idleInterrupt = await check("turn/interrupt", { threadId: deep.thread.id, turnId: "synthetic-idle-turn" });
      result.codex.modelChange = await check("thread/settings/update", { threadId: fast.thread.id, model: "gpt-6-sol", effort: "high" });
      result.codex.afterModelChange = await check("thread/read", { threadId: fast.thread.id, includeTurns: false });
    } catch (error) { result.codex.blocked = error.code === "ENOENT" ? "cli_missing" : "control_probe_failed"; }
    try {
      const { stdout: version } = await exec(claudeBin, ["--version"], { ...options, env });
      result.claude.version = safeVersion(version);
      const { stdout: help } = await exec(claudeBin, ["--help"], { ...options, env });
      result.claude.flags = Object.fromEntries(["resume", "fork-session", "session-id", "model", "effort", "input-format", "output-format"].map(flag => [flag, help.includes(`--${flag}`)]));
      const { stdout } = await exec(claudeBin, ["auth", "status", "--json"], { ...options, env });
      const auth = JSON.parse(stdout);
      result.claude.auth = { authenticated: claudeCodeStatusAuthenticated(stdout), subscription: ["claude.ai", "oauth_token", "subscription_token", "oauth"].includes(auth.authMethod) };
    } catch (error) { result.claude.blocked = error.code === "ENOENT" ? "cli_missing" : "status_probe_failed"; }
    return result;
  } finally {
    if (client) {
      const stopped = client.proc && client.proc.exitCode === null
        ? new Promise(resolve => { client.proc.once("close", resolve); setTimeout(resolve, 2000).unref(); }) : Promise.resolve();
      client.close();
      await stopped;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--run-no-inference") {
    console.error("Opt in with --run-no-inference. No prompts, model turns, login or downloads are performed.");
    process.exitCode = 2;
  } else console.log(JSON.stringify(await probeInstalledSessions(), null, 2));
}
