import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDataDirs } from "../../storage/src/paths.js";

const deviceAuthTtlMs = 15 * 60 * 1000;
const authSessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

export function defaultCodexHome(env = process.env, home = os.homedir()) {
  return path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
}

function codexCommand(env = process.env) {
  return String(env.ORKESTR_CODEX_BIN || "codex").trim() || "codex";
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
  const current = activeSession(codexHome);
  if (current) return sessionSnapshot(current);

  const command = codexCommand(env);
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
