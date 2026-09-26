import path from "node:path";
import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { claudeCodeYoloAllowedMcpTools } from "./claude-code-mcp-policy.js";
import { claudeCodeStatusAuthenticated } from "./claude-code-auth-status.js";
import { claudeCodeRuntimeEnv, claudeCodeExecutionEnv } from "./claude-code-environment.js";
import { claudeCodeEventTelemetry, mergeClaudeCodeTelemetry } from "./claude-code-telemetry.js";
export { claudeCodeRuntimeEnv, claudeCodeExecutionEnv } from "./claude-code-environment.js";
export { claudeCodeEventTelemetry, mergeClaudeCodeTelemetry } from "./claude-code-telemetry.js";

const execFileAsync = promisify(execFile);
const loginSessions = new Map();
const loginTtlMs = 15 * 60 * 1000;
const loginVerifyTimeoutMs = 60 * 1000;
const loginStartTimeoutMs = 3_000;

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value = "") {
  return ["1", "true", "yes", "on", "enabled"].includes(clean(value).toLowerCase());
}

export function claudeCodeEnabled(env = process.env) {
  return truthy(env.ORKESTR_CLAUDE_CODE_ENABLED);
}

export function claudeCodeCommand(env = process.env) {
  return clean(env.ORKESTR_CLAUDE_CODE_BIN || "claude") || "claude";
}

function claudeLoginTransport(env = process.env) {
  return clean(env.ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT || "pty").toLowerCase() === "pipe" ? "pipe" : "pty";
}

function shellQuote(value = "") {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function loginSpawn(profile = {}, thread = {}, env = process.env) {
  const command = claudeCodeCommand(env);
  const runtimeEnv = claudeCodeRuntimeEnv(profile, thread, env);
  if (claudeLoginTransport(env) === "pipe") {
    return { command, args: ["auth", "login", "--claudeai"], env: runtimeEnv, interactive: false };
  }
  const ttyCommand = clean(env.ORKESTR_CLAUDE_CODE_TTY_BIN || "script") || "script";
  const commandLine = `stty cols 5000 rows 50 2>/dev/null; exec ${shellQuote(command)}`;
  return {
    command: ttyCommand,
    args: ["-qefc", commandLine, "/dev/null"],
    env: { ...runtimeEnv, TERM: runtimeEnv.TERM || "xterm-256color", COLUMNS: "5000", LINES: "50" },
    interactive: true,
  };
}

export function claudeCodeTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_CODE_TIMEOUT_MS || 30 * 60 * 1000);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : 30 * 60 * 1000;
}

export function claudeCodeMaxOutputBytes(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_CODE_MAX_OUTPUT_BYTES || 16 * 1024 * 1024);
  return Number.isFinite(parsed) && parsed >= 64 * 1024 ? Math.floor(parsed) : 16 * 1024 * 1024;
}

export function claudeCodePermissionMode(thread = {}) {
  const requested = clean(thread?.executor?.metadata?.claudePermissionMode || thread?.claudePermissionMode || "acceptEdits");
  return new Set(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]).has(requested) ? requested : "acceptEdits";
}

function modelForThread(thread = {}) {
  const value = clean(thread?.executor?.metadata?.claudeModel || thread?.claudeModel);
  return /^[a-zA-Z0-9._:-]{1,120}$/.test(value) ? value : "";
}

export function claudeCodeArgs(thread = {}, options = {}, env = process.env) {
  const mode = claudeCodePermissionMode(thread);
  if (mode === "bypassPermissions" && !truthy(env.ORKESTR_CLAUDE_CODE_ALLOW_BYPASS_PERMISSIONS)) {
    const error = new Error("claude_code_bypass_permissions_disabled");
    error.code = error.message;
    error.statusCode = 403;
    throw error;
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode];
  if (mode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
    const allowedMcpTools = claudeCodeYoloAllowedMcpTools(env);
    if (allowedMcpTools.length) args.push("--allowedTools", allowedMcpTools.join(","));
  }
  const model = modelForThread(thread);
  if (model) args.push("--model", model);
  const effort = clean(thread?.executor?.metadata?.claudeEffort || thread?.claudeEffort);
  if (["low", "medium", "high", "max"].includes(effort)) args.push("--effort", effort);
  if (clean(options.statusCaptureCommand)) {
    args.push("--settings", JSON.stringify({ statusLine: { type: "command", command: clean(options.statusCaptureCommand) } }));
  }
  if (clean(options.sessionId)) {
    // A resumed transcript keeps the user message of a turn that failed before
    // Claude answered (API errors are not replayed to the model). Without this
    // notice the stale request merges with the new one and reads as an override.
    if (options.priorTurnFailed) args.push("--append-system-prompt", CLAUDE_CODE_FAILED_TURN_NOTICE);
    args.push("--resume", clean(options.sessionId));
  }
  return args;
}

export const CLAUDE_CODE_FAILED_TURN_NOTICE = [
  "Orkestr runtime notice: the previous user turn in this conversation failed with a runtime or provider error before you answered it.",
  "That turn is void; do not complete or enforce its instructions.",
  "Treat only the latest user message as the current request.",
].join(" ");

export function claudeCodeStatusCapture(profile = {}, thread = {}) {
  const key = crypto.createHash("sha256").update(clean(thread.id)).digest("hex");
  const capturePath = path.join(profile.credentialRoot, "telemetry", `${key}.json`);
  const script = fileURLToPath(new URL("./claude-statusline-capture.js", import.meta.url));
  return { capturePath, command: `${shellQuote(process.execPath)} ${shellQuote(script)}` };
}

export async function readClaudeCodeStatusTelemetry(capturePath = "") {
  try {
    const parsed = JSON.parse(await fs.readFile(capturePath, "utf8"));
    const observedAt = Date.parse(parsed.observedAt || "");
    if (!Number.isFinite(observedAt) || Date.now() - observedAt > 5 * 60 * 1000) return null;
    return claudeCodeEventTelemetry(parsed);
  } catch {
    return null;
  }
}

export function classifyClaudeCodeFailure(value = "") {
  const text = clean(value).toLowerCase();
  if (/rate.?limit|usage.?limit|quota|too many requests|\bhit (?:your )?limit\b|\b429\b/.test(text)) return "claude_code_rate_limited";
  if (/auth|login|sign.?in|credential|unauthori[sz]ed|forbidden|\b401\b|\b403\b/.test(text)) return "claude_code_auth_required";
  if (/timed?.?out|timeout/.test(text)) return "claude_code_timeout";
  if (/not found|enoent/.test(text)) return "claude_code_cli_missing";
  if (/output.*limit|too.*large/.test(text)) return "claude_code_output_limit";
  if (/interrupt|sigterm|sigkill|cancel/.test(text)) return "claude_code_interrupted";
  return "claude_code_failed";
}

export function claudeCodeEventSessionId(event = {}) {
  return clean(event.session_id || event.sessionId || event.message?.session_id || event.message?.sessionId);
}

function blockText(block = {}) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (["text", "output_text"].includes(clean(block.type).toLowerCase())) return clean(block.text || block.content);
  return "";
}

export function claudeCodeEventText(event = {}) {
  const type = clean(event.type).toLowerCase();
  if (type === "result") return clean(event.result || event.text);
  if (type !== "assistant") return "";
  const content = Array.isArray(event.message?.content) ? event.message.content : Array.isArray(event.content) ? event.content : [];
  return content.map(blockText).filter(Boolean).join("\n").trim();
}

export async function claudeCodeLoginStatus(profile = {}, thread = {}, env = process.env) {
  const command = claudeCodeCommand(env);
  const runtimeEnv = await claudeCodeExecutionEnv(profile, thread, env);
  await Promise.all([
    fs.mkdir(runtimeEnv.HOME, { recursive: true, mode: 0o700 }),
    fs.mkdir(runtimeEnv.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  try {
    const { stdout = "" } = await execFileAsync(command, ["auth", "status", "--json"], {
      env: runtimeEnv,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const authenticated = claudeCodeStatusAuthenticated(stdout);
    return { available: true, authenticated, reason: authenticated ? "logged_in" : "not_logged_in" };
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, authenticated: false, reason: "claude_code_cli_missing" };
    return { available: true, authenticated: false, reason: classifyClaudeCodeFailure(`${error?.stdout || ""} ${error?.stderr || ""} ${error?.message || ""}`) };
  }
}

function safeClaudeAuthUrl(output = "") {
  const matches = String(output || "").match(/https:\/\/[^\s<>"']+/g) || [];
  for (const candidate of matches) {
    try {
      const parsed = new URL(candidate.replace(/[),.;]+$/g, ""));
      const host = parsed.hostname.toLowerCase();
      if (
        host === "claude.ai" || host.endsWith(".claude.ai") ||
        host === "claude.com" || host.endsWith(".claude.com") ||
        host === "anthropic.com" || host.endsWith(".anthropic.com")
      ) {
        return parsed.toString();
      }
    } catch {}
  }
  return "";
}

function loginSnapshot(session = {}) {
  return {
    state: clean(session.state || "starting"),
    authUrl: clean(session.authUrl) || null,
    codeSubmitted: Boolean(session.codeSubmittedAt),
    startedAt: clean(session.startedAt),
    expiresAt: clean(session.expiresAt),
    failureCode: clean(session.failureCode) || null,
  };
}

function activeLogin(profileId = "") {
  const session = loginSessions.get(clean(profileId));
  if (!session) return null;
  if (Date.parse(session.expiresAt || "") <= Date.now()) {
    if (!session.closed) session.proc?.kill("SIGTERM");
    loginSessions.delete(clean(profileId));
    return null;
  }
  return session;
}

export function claudeCodeLoginSession(profileId = "") {
  const session = activeLogin(profileId);
  return session ? loginSnapshot(session) : null;
}

export function cancelClaudeCodeLogin(profileId = "") {
  const id = clean(profileId);
  const session = loginSessions.get(id);
  if (!session) return false;
  if (!session.closed) session.proc?.kill("SIGTERM");
  session.proc?.stdin?.destroy();
  session.output = "";
  loginSessions.delete(id);
  return true;
}

export async function submitClaudeCodeLoginCode(profileId = "", authorizationCode = "") {
  const session = activeLogin(profileId);
  if (!session || session.closed || !session.proc?.stdin?.writable) {
    const error = new Error("claude_code_login_session_not_active");
    error.statusCode = 409;
    throw error;
  }
  if (session.codeSubmittedAt) {
    const error = new Error("claude_code_login_code_already_submitted");
    error.statusCode = 409;
    throw error;
  }
  const code = clean(authorizationCode);
  if (!code || code.length > 2048 || /\s/.test(code) || !/^[A-Za-z0-9._~+/=-]+#[A-Za-z0-9._~+/=-]+$/.test(code)) {
    const error = new Error("claude_code_login_code_invalid");
    error.statusCode = 400;
    throw error;
  }
  session.codeSubmittedAt = new Date().toISOString();
  await new Promise((resolve, reject) => {
    session.proc.stdin.write(`${code}${session.interactive ? "\r" : "\n"}`, (error) => error ? reject(error) : resolve());
  }).catch((error) => {
    session.codeSubmittedAt = "";
    const wrapped = new Error("claude_code_login_code_submit_failed");
    wrapped.statusCode = 409;
    wrapped.cause = error;
    throw wrapped;
  });
  session.output = "";
  monitorAuthenticatedLogin(session);
  return loginSnapshot(session);
}

function monitorAuthenticatedLogin(session) {
  if (session.verifying || session.state === "completed") return;
  session.verifying = true;
  const startedAt = Date.now();
  void (async () => {
    while (Date.now() - startedAt < loginVerifyTimeoutMs && session.state !== "completed" && session.state !== "failed") {
      const status = await claudeCodeLoginStatus(session.profile, session.thread, session.env);
      if (status.authenticated) {
        session.authenticated = true;
        session.state = "completed";
        session.failureCode = "";
        session.output = "";
        if (!session.closed) session.proc?.kill("SIGTERM");
        return;
      }
      if (session.closed) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (session.state !== "completed" && session.codeSubmittedAt) {
      session.state = "failed";
      session.failureCode = "claude_code_auth_required";
      session.output = "";
      if (!session.closed) session.proc?.kill("SIGTERM");
    }
  })().catch(() => {
    // A profile may be rotated/revoked while verification is awaiting the CLI.
    // Keep the attended flow fail-closed without an unhandled rejection.
    session.state = "failed";
    session.failureCode = "claude_code_login_failed";
    session.output = "";
    if (!session.closed) session.proc?.kill("SIGTERM");
  }).finally(() => {
    session.verifying = false;
  });
}

export async function startClaudeCodeLogin(profile = {}, thread = {}, env = process.env) {
  if (profile.authenticationMethod === "subscription_token") {
    const error = new Error("claude_subscription_token_rotation_required");
    error.statusCode = 409;
    throw error;
  }
  if (profile.authMode !== "subscription") {
    const error = new Error("llm_account_auth_mode_unsupported");
    error.statusCode = 409;
    throw error;
  }
  const existing = activeLogin(profile.id);
  if (existing) return loginSnapshot(existing);
  const login = loginSpawn(profile, thread, env);
  await Promise.all([
    fs.mkdir(login.env.HOME, { recursive: true, mode: 0o700 }),
    fs.mkdir(login.env.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  const session = {
    state: "starting",
    authUrl: "",
    failureCode: "",
    codeSubmittedAt: "",
    output: "",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + loginTtlMs).toISOString(),
    closed: false,
    proc: null,
    profile,
    thread,
    env,
    interactive: login.interactive,
    verifying: false,
    authenticated: false,
    onboardingThemeAccepted: false,
    onboardingLoginMethodAccepted: false,
    authUrlRequested: false,
  };
  const proc = spawn(login.command, login.args, {
    env: login.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  session.proc = proc;
  loginSessions.set(clean(profile.id), session);
  const timeout = setTimeout(() => {
    if (!session.closed) proc.kill("SIGTERM");
  }, loginTtlMs);
  timeout.unref?.();
  const cleanup = setTimeout(() => loginSessions.delete(clean(profile.id)), loginTtlMs + 1_000);
  cleanup.unref?.();

  function consume(chunk) {
    if (session.codeSubmittedAt) return;
    session.output = `${session.output}${String(chunk || "")}`.slice(-32 * 1024);
    if (session.interactive && !session.onboardingThemeAccepted && /Choose the text style/i.test(session.output)) {
      session.onboardingThemeAccepted = true;
      proc.stdin.write("\r");
    }
    if (session.interactive && !session.onboardingLoginMethodAccepted && /Select login method/i.test(session.output)) {
      session.onboardingLoginMethodAccepted = true;
      proc.stdin.write("\r");
    }
    if (session.interactive && !session.authUrlRequested && /Opening browser to sign in/i.test(session.output)) {
      session.authUrlRequested = true;
      setTimeout(() => {
        if (!session.closed && !session.authUrl) proc.stdin.write("c");
      }, 250).unref?.();
    }
    session.authUrl = safeClaudeAuthUrl(session.output) || session.authUrl;
    if (session.authUrl && session.state === "starting") session.state = "pending";
  }
  proc.stdout.on("data", consume);
  proc.stderr.on("data", consume);
  proc.on("error", (error) => {
    session.closed = true;
    session.state = "failed";
    session.failureCode = error?.code === "ENOENT" ? "claude_code_cli_missing" : "claude_code_login_failed";
    session.output = "";
  });
  proc.on("close", async (code) => {
    clearTimeout(timeout);
    session.closed = true;
    proc.stdin.destroy();
    if (session.authenticated || session.state === "completed") {
      session.state = "completed";
      session.failureCode = "";
      session.output = "";
      return;
    }
    const status = code === 0 ? await claudeCodeLoginStatus(profile, thread, env) : null;
    session.state = status?.authenticated ? "completed" : "failed";
    session.failureCode = status?.authenticated ? "" : code === 0 ? status?.reason || "claude_code_auth_required" : classifyClaudeCodeFailure(session.output);
    session.output = "";
  });
  const startDeadline = Date.now() + loginStartTimeoutMs;
  while (session.state === "starting" && Date.now() < startDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return loginSnapshot(session);
}
