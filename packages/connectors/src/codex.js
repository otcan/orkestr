import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { ensureDataDirs } from "../../storage/src/paths.js";

const deviceAuthTtlMs = 15 * 60 * 1000;
const authSessions = new Map();
export const CODEX_DISABLED_ON_MACOS = "__orkestr_codex_disabled_on_macos__";

function nowIso() {
  return new Date().toISOString();
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function runtimeHome(env = process.env, home = os.homedir()) {
  return String(env.HOME || home || os.homedir() || "").trim();
}

export function defaultCodexHome(env = process.env, home = os.homedir()) {
  return path.resolve(env.CODEX_HOME || path.join(runtimeHome(env, home), ".codex"));
}

export function codexCommand(env = process.env) {
  const command = String(env.ORKESTR_CODEX_BIN || "codex").trim() || "codex";
  return command === CODEX_DISABLED_ON_MACOS ? "" : command;
}

function ensureCodexHome(codexHome) {
  try {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  } catch {
    // Let the Codex CLI surface a concrete configuration error.
  }
}

function runCodex(args, { env = process.env, home = os.homedir(), input = "", timeoutMs = 5000 } = {}) {
  const command = codexCommand(env);
  const codexHome = defaultCodexHome(env, home);
  ensureCodexHome(codexHome);
  if (!command) {
    return Promise.resolve({ command, codexHome, code: null, signal: null, stdout: "", stderr: "", disabled: true });
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...env,
        HOME: runtimeHome(env, home),
        CODEX_HOME: codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      resolve({ command, codexHome, code: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
    }, Math.max(1000, timeoutMs));
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") stderr += String(error?.message || error || "");
    });
    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ command, codexHome, code: null, signal: null, stdout, stderr, error });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ command, codexHome, code, signal, stdout, stderr });
    });
    child.stdin.end(input ? `${String(input).replace(/\n*$/g, "")}\n` : "");
  });
}

function authModeFromStatus(output) {
  if (/api\s*key/i.test(output)) return "api_key";
  if (/chatgpt/i.test(output)) return "chatgpt";
  if (/logged\s+in/i.test(output)) return "codex_auth";
  return null;
}

export async function codexLoginStatus({ env = process.env, home = os.homedir(), timeoutMs = 5000 } = {}) {
  const result = await runCodex(["login", "status"], { env, home, timeoutMs });
  const output = stripAnsi(`${result.stdout || ""}\n${result.stderr || ""}`).trim();
  const missing = result.error?.code === "ENOENT";
  const disabled = Boolean(result.disabled);
  const connected = !missing && result.code === 0 && /\blogged\s+in\b/i.test(output) && !/\bnot\s+logged\s+in\b/i.test(output);
  const authMode = connected ? authModeFromStatus(output) : null;
  return {
    ok: connected,
    connected,
    command: result.command,
    codexHome: result.codexHome,
    authMode,
    statusText: output,
    available: !missing && !disabled,
    timedOut: Boolean(result.timedOut),
    code: result.code,
    reason: disabled ? "codex_disabled_on_macos" : missing ? "codex_missing" : connected ? "logged_in" : result.timedOut ? "status_timeout" : "not_logged_in",
    message: disabled
      ? "Codex host binary is disabled for this macOS local install. Verify Codex manually, then rerun the installer with ORKESTR_ENABLE_HOST_CODEX=1."
      : missing
        ? "Codex CLI is not installed."
        : connected
          ? `Codex is logged in${authMode ? ` using ${authMode}.` : "."}`
          : output || "Codex is not logged in.",
  };
}

export async function loginCodexWithApiKey(apiKey, { env = process.env, home = os.homedir(), timeoutMs = 15000 } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    const error = new Error("openai_api_key_required");
    error.statusCode = 400;
    throw error;
  }
  const result = await runCodex(["login", "--with-api-key"], { env, home, input: key, timeoutMs });
  const output = stripAnsi(`${result.stdout || ""}\n${result.stderr || ""}`).trim();
  if (result.disabled) {
    const error = new Error("codex_cli_disabled_on_macos");
    error.statusCode = 428;
    throw error;
  }
  if (result.error?.code === "ENOENT") {
    const error = new Error("codex_cli_missing");
    error.statusCode = 404;
    throw error;
  }
  if (result.timedOut) {
    const error = new Error("codex_login_timeout");
    error.statusCode = 504;
    throw error;
  }
  if (result.code !== 0) {
    const error = new Error(output || `codex_login_failed:${result.code}`);
    error.statusCode = 400;
    throw error;
  }
  const status = await codexLoginStatus({ env, home, timeoutMs: 5000 });
  return {
    ok: status.connected,
    state: status.connected ? "connected" : "partial",
    command: result.command,
    codexHome: result.codexHome,
    authMode: status.authMode || "api_key",
    message: status.connected ? "Codex API key login completed." : status.message,
  };
}

export async function assertCodexAuthenticated({ env = process.env, home = os.homedir() } = {}) {
  if (String(env.ORKESTR_CODEX_AUTH_PREFLIGHT || "").trim() === "0") {
    return { skipped: true };
  }
  const status = await codexLoginStatus({ env, home, timeoutMs: 5000 });
  if (status.connected) return status;
  const error = new Error("Codex is not signed in. Open /setup/codex and connect Codex before starting a coding agent.");
  error.code = "codex_auth_required";
  error.statusCode = 428;
  error.status = status;
  throw error;
}

function sessionSnapshot(session) {
  return {
    ok: Boolean(session.code && session.authUrl),
    state: session.state,
    command: session.command,
    codexHome: session.codexHome,
    authUrl: session.authUrl || "https://auth.openai.com/codex/device",
    code: session.code || "",
    expiresAt: session.expiresAt,
    startedAt: session.startedAt,
    message: session.message || "",
  };
}

function parseDeviceAuthOutput(session) {
  const output = stripAnsi(session.output);
  const url = output.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0];
  const code = output.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)?.[0];
  if (url) session.authUrl = url;
  if (code) session.code = code;
}

function activeSession(codexHome) {
  const session = authSessions.get(codexHome);
  if (!session) return null;
  if (Date.parse(session.expiresAt || "") <= Date.now() || session.closed) {
    authSessions.delete(codexHome);
    return null;
  }
  return session;
}

export async function startCodexDeviceAuth({ env = process.env, home = os.homedir() } = {}) {
  await ensureDataDirs(env);
  const codexHome = defaultCodexHome(env, home);
  ensureCodexHome(codexHome);
  const command = codexCommand(env);
  if (!command) {
    const error = new Error("codex_cli_disabled_on_macos");
    error.statusCode = 428;
    throw error;
  }
  const current = activeSession(codexHome);
  if (current) return sessionSnapshot(current);

  const session = {
    command,
    codexHome,
    startedAt: nowIso(),
    expiresAt: new Date(Date.now() + deviceAuthTtlMs).toISOString(),
    state: "starting",
    authUrl: "",
    code: "",
    output: "",
    message: "",
    closed: false,
  };
  authSessions.set(codexHome, session);

  const child = spawn(command, ["login", "--device-auth"], {
    env: {
      ...process.env,
      ...env,
      HOME: home,
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;

  const killTimer = setTimeout(() => {
    if (!session.closed) child.kill("SIGTERM");
  }, deviceAuthTtlMs + 1000);
  killTimer.unref?.();

  return new Promise((resolve, reject) => {
    let resolved = false;
    const readyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        session.state = session.code ? "pending" : "waiting_for_code";
        resolve(sessionSnapshot(session));
      }
    }, 12000);
    readyTimer.unref?.();

    function maybeResolve() {
      parseDeviceAuthOutput(session);
      if (!resolved && session.code && session.authUrl) {
        resolved = true;
        session.state = "pending";
        clearTimeout(readyTimer);
        resolve(sessionSnapshot(session));
      }
    }

    child.stdout.on("data", (chunk) => {
      session.output += String(chunk || "");
      maybeResolve();
    });
    child.stderr.on("data", (chunk) => {
      session.output += String(chunk || "");
      maybeResolve();
    });
    child.on("error", (error) => {
      session.closed = true;
      session.state = "failed";
      session.message = error?.message || String(error);
      authSessions.delete(codexHome);
      if (!resolved) {
        resolved = true;
        clearTimeout(readyTimer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      session.closed = true;
      session.state = code === 0 ? "completed" : "failed";
      session.message = code === 0 ? "Codex sign-in completed." : `Codex sign-in exited with code ${code}.`;
      clearTimeout(killTimer);
      if (session.state === "completed") authSessions.delete(codexHome);
      if (!resolved) {
        resolved = true;
        clearTimeout(readyTimer);
        resolve(sessionSnapshot(session));
      }
    });
  });
}
