import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexLoginStatus, defaultCodexHome } from "../../connectors/src/codex.js";
import { dataPaths } from "../../storage/src/paths.js";
import { securityStatus } from "./security.js";

const execFileAsync = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

function firstLine(value) {
  return String(value || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function cleanMessage(error) {
  if (!error) return "";
  if (error.code === "ENOENT") return "not_installed";
  return firstLine(error.stderr || error.stdout || error.message || String(error)) || "command_failed";
}

function doctorCheck(id, label, status, summary, detail = {}) {
  return {
    id,
    label,
    status,
    summary,
    severity: status === "error" ? "error" : status === "warning" ? "warning" : "info",
    ...detail,
  };
}

function commandEnv(env) {
  return { ...process.env, ...env };
}

async function runCommand(command, args = ["--version"], env = process.env, timeoutMs = 2500) {
  try {
    const result = await execFileAsync(command, args, {
      env: commandEnv(env),
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
    });
    return {
      ok: true,
      command,
      output: firstLine(result.stdout || result.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      command,
      error: cleanMessage(error),
      code: error?.code || "",
    };
  }
}

async function commandCheck({ id, label, command, args = ["--version"], env, required = true, repair }) {
  const result = await runCommand(command, args, env);
  if (result.ok) {
    return doctorCheck(id, label, "ok", result.output || `${command} is available.`, {
      command: result.command,
      repair: "",
    });
  }
  return doctorCheck(
    id,
    label,
    required ? "error" : "warning",
    `${command} is not available${result.error ? ` (${result.error})` : ""}.`,
    {
      command: result.command,
      error: result.error,
      repair: repair || `Install ${command} on the Orkestr host.`,
    },
  );
}

async function firstCommandCheck({ id, label, commands, args = ["--version"], env, required = true, repair }) {
  const failures = [];
  for (const command of commands) {
    const result = await runCommand(command, args, env);
    if (result.ok) {
      return doctorCheck(id, label, "ok", result.output || `${command} is available.`, {
        command: result.command,
        repair: "",
      });
    }
    failures.push(`${command}:${result.error || "failed"}`);
  }
  return doctorCheck(
    id,
    label,
    required ? "error" : "warning",
    `No matching command found. Tried ${commands.join(", ")}.`,
    {
      commands,
      error: failures.join("; "),
      repair,
    },
  );
}

async function writablePathCheck(id, label, targetPath, env) {
  const tempFile = path.join(targetPath, `.orkestr-doctor-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(targetPath, { recursive: true });
    await fs.access(targetPath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    await fs.writeFile(tempFile, "ok", { flag: "wx", mode: 0o600 });
    await fs.unlink(tempFile).catch(() => {});
    return doctorCheck(id, label, "ok", targetPath, { path: targetPath });
  } catch (error) {
    await fs.unlink(tempFile).catch(() => {});
    return doctorCheck(id, label, "error", `${targetPath}: ${error?.message || String(error)}`, {
      path: targetPath,
      repair: `Make ${targetPath} writable by the Orkestr service user.`,
    });
  }
}

async function codexCheck(env, home) {
  try {
    const status = await codexLoginStatus({ env, home, timeoutMs: 2500 });
    if (!status.available) {
      return doctorCheck("codex", "Codex CLI", "error", status.message || "Codex CLI is not installed.", {
        command: status.command,
        path: status.codexHome,
        repair: "Install Codex in the Orkestr runtime or use the Docker image.",
      });
    }
    if (status.connected) {
      return doctorCheck("codex", "Codex CLI", "ok", status.message || "Codex is logged in.", {
        command: status.command,
        path: status.codexHome,
        authMode: status.authMode || "",
      });
    }
    return doctorCheck("codex", "Codex CLI", "warning", status.message || "Codex is not logged in.", {
      command: status.command,
      path: status.codexHome,
      repair: "Open setup, choose Codex, and complete device auth or API-key login.",
    });
  } catch (error) {
    return doctorCheck("codex", "Codex CLI", "error", error?.message || String(error), {
      repair: "Check the Codex command and ORKESTR_CODEX_BIN.",
    });
  }
}

async function browserCheck(env) {
  const configured = String(env.ORKESTR_CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || env.WA_CHROME_PATH || "").trim();
  if (configured) {
    return commandCheck({
      id: "browser",
      label: "Chrome browser",
      command: configured,
      args: ["--version"],
      env,
      required: true,
      repair: "Fix the configured browser path or install Chromium/Chrome.",
    });
  }
  return firstCommandCheck({
    id: "browser",
    label: "Chrome browser",
    commands: ["google-chrome", "chrome", "chromium", "chromium-browser"],
    env,
    required: true,
    repair: "Install Chromium or Google Chrome for virtual desktops and browser-backed connectors.",
  });
}

function securityChecks(security) {
  const checks = [];
  if (security.externallyLocal) {
    checks.push(doctorCheck("network_bind", "Network bind", "ok", `Bound safely through ${security.bindHost || "localhost"}.`));
  } else {
    checks.push(doctorCheck("network_bind", "Network bind", "warning", `Orkestr is bound to ${security.bindHost || "a non-local address"}.`, {
      repair: "Bind Orkestr to localhost and expose it through Caddy/Tailscale, or require browser pairing before remote access.",
    }));
  }

  if (security.externallyLocal) {
    checks.push(doctorCheck("browser_pairing", "Browser pairing", "ok", "Local-only access does not require browser pairing."));
  } else if (security.authEnabled) {
    checks.push(doctorCheck(
      "browser_pairing",
      "Browser pairing",
      security.paired ? "ok" : "warning",
      security.paired ? `${security.sessionCount || 0} browser session(s) paired.` : "Pairing is enabled, but this browser is not paired yet.",
      { repair: "Generate a pairing challenge in setup and approve it with `orkestr security approve <challenge-id>`." },
    ));
  } else {
    checks.push(doctorCheck("browser_pairing", "Browser pairing", "error", "Remote access is not protected by browser pairing.", {
      repair: "Set ORKESTR_AUTH_REQUIRED=1 and approve browsers through the setup pairing flow.",
    }));
  }

  const httpsConfigured = Boolean(security.https?.configured);
  if (security.externallyLocal || httpsConfigured) {
    checks.push(doctorCheck(
      "https_endpoint",
      "HTTPS endpoint",
      "ok",
      httpsConfigured ? security.https.url || "HTTPS endpoint is configured." : "Local-only access does not require a public certificate.",
    ));
  } else {
    checks.push(doctorCheck("https_endpoint", "HTTPS endpoint", "error", "No HTTPS endpoint is configured for remote access.", {
      repair: "Configure Caddy/Tailscale and set ORKESTR_PUBLIC_HTTPS_URL before exposing Orkestr remotely.",
    }));
  }

  checks.push(doctorCheck(
    "caddy",
    "Caddy",
    security.caddy?.installed || security.caddy?.configured ? "ok" : "warning",
    security.caddy?.version || security.caddy?.error || "Caddy is not installed.",
    { repair: "Install Caddy on VPS hosts that need automatic TLS." },
  ));

  checks.push(doctorCheck(
    "tailscale",
    "Tailscale",
    security.tailscale?.installed || security.tailscale?.configured ? "ok" : "warning",
    security.tailscale?.version || security.tailscale?.error || "Tailscale is not installed.",
    { repair: "Install Tailscale when using tailnet-only access." },
  ));

  return checks;
}

function summarize(checks) {
  const counts = {
    total: checks.length,
    ok: checks.filter((check) => check.status === "ok").length,
    warnings: checks.filter((check) => check.status === "warning").length,
    errors: checks.filter((check) => check.status === "error").length,
  };
  const status = counts.errors ? "broken" : counts.warnings ? "warning" : "ok";
  const summary = counts.errors
    ? `${counts.errors} system check(s) need attention before Orkestr is production-ready.`
    : counts.warnings
      ? `${counts.warnings} system check(s) need review.`
      : "All system checks passed.";
  return { counts, status, summary };
}

export async function systemDoctor({ env = process.env, home = os.homedir() } = {}) {
  const paths = dataPaths(env);
  const commandChecks = await Promise.all([
    commandCheck({
      id: "node",
      label: "Node.js",
      command: process.execPath,
      args: ["--version"],
      env,
      required: true,
      repair: "Install Node.js 22 or newer.",
    }),
    commandCheck({
      id: "git",
      label: "Git",
      command: "git",
      args: ["--version"],
      env,
      required: true,
      repair: "Install git for repository clone and workspace management.",
    }),
    commandCheck({
      id: "tmux",
      label: "tmux",
      command: "tmux",
      args: ["-V"],
      env,
      required: true,
      repair: "Install tmux for persistent agent sessions.",
    }),
    commandCheck({
      id: "ripgrep",
      label: "ripgrep",
      command: "rg",
      args: ["--version"],
      env,
      required: false,
      repair: "Install ripgrep to improve search inside coding sessions.",
    }),
    commandCheck({
      id: "npm",
      label: "npm",
      command: "npm",
      args: ["--version"],
      env,
      required: false,
      repair: "Install npm when running host-native builds or updates.",
    }),
    browserCheck(env),
    codexCheck(env, home),
  ]);

  const pathChecks = await Promise.all([
    writablePathCheck("data_home", "Orkestr home", paths.home, env),
    writablePathCheck("workspace_root", "Workspace root", paths.workspaces, env),
    writablePathCheck("secret_store", "Secret store", paths.secrets, env),
  ]);

  let security = null;
  let securityDoctorChecks = [];
  try {
    security = await securityStatus(env);
    securityDoctorChecks = securityChecks(security);
  } catch (error) {
    securityDoctorChecks = [
      doctorCheck("security_status", "Security status", "error", error?.message || String(error), {
        repair: "Check ORKESTR_HOME permissions and security configuration.",
      }),
    ];
  }

  const checks = [...pathChecks, ...commandChecks, ...securityDoctorChecks];
  const { counts, status, summary } = summarize(checks);
  const issues = checks
    .filter((check) => check.status !== "ok")
    .map((check) => ({
      severity: check.severity,
      code: check.id,
      label: check.label,
      message: check.summary,
      repair: check.repair || "",
    }));

  return {
    ok: status === "ok",
    status,
    summary,
    generatedAt: nowIso(),
    counts,
    paths: {
      home: paths.home,
      workspaces: paths.workspaces,
      secrets: paths.secrets,
      codexHome: defaultCodexHome(env, home),
    },
    security,
    checks,
    issues,
  };
}
