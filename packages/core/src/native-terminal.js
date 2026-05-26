import { spawn } from "node:child_process";

function clean(value) {
  return String(value || "").trim();
}

export function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function commandInDirectory(command, cwd) {
  const workingDirectory = clean(cwd);
  return workingDirectory ? `cd ${shellQuote(workingDirectory)} && ${command}` : command;
}

function terminalSessionCommand(command, cwd) {
  const run = commandInDirectory(command, cwd);
  return `${run}; printf '\\n[Orkestr terminal exited. Press Enter to close.]\\n'; read _`;
}

function replaceTemplate(template, values) {
  let result = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, shellQuote(value));
  }
  return result;
}

function linuxTerminalScript(command, cwd, title) {
  const run = terminalSessionCommand(command, cwd);
  return `
set -eu
title=${shellQuote(title)}
run=${shellQuote(run)}
if command -v x-terminal-emulator >/dev/null 2>&1; then
  exec x-terminal-emulator -T "$title" -e sh -lc "$run"
fi
if command -v gnome-terminal >/dev/null 2>&1; then
  exec gnome-terminal --title "$title" -- sh -lc "$run"
fi
if command -v konsole >/dev/null 2>&1; then
  exec konsole --new-tab -p tabtitle="$title" -e sh -lc "$run"
fi
if command -v xterm >/dev/null 2>&1; then
  exec xterm -T "$title" -e sh -lc "$run"
fi
echo "No supported terminal emulator found. Set ORKESTR_NATIVE_TERMINAL_COMMAND." >&2
exit 127
`.trim();
}

export function nativeTerminalLaunchSpec(command, options = {}, env = process.env, platform = process.platform) {
  const attachCommand = clean(command);
  if (!attachCommand) throw new Error("native_terminal_command_required");

  const title = clean(options.title) || "Orkestr";
  const cwd = clean(options.cwd);
  const configured = clean(env.ORKESTR_NATIVE_TERMINAL_COMMAND || env.ORKESTR_TERMINAL_COMMAND);
  if (configured) {
    return {
      command: "sh",
      args: ["-lc", replaceTemplate(configured, { command: attachCommand, cwd, title })],
      cwd: cwd || undefined,
      launcher: "configured",
    };
  }

  if (platform === "darwin") {
    const run = terminalSessionCommand(attachCommand, cwd);
    return {
      command: "osascript",
      args: ["-e", `tell application "Terminal" to do script ${appleScriptString(run)}`],
      cwd: cwd || undefined,
      launcher: "terminal.app",
    };
  }

  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", "start", title, "cmd.exe", "/k", commandInDirectory(attachCommand, cwd)],
      cwd: cwd || undefined,
      launcher: "cmd",
    };
  }

  return {
    command: "sh",
    args: ["-lc", linuxTerminalScript(attachCommand, cwd, title)],
    cwd: cwd || undefined,
    launcher: "linux-terminal",
  };
}

export async function launchNativeTerminal(command, options = {}, env = process.env) {
  const spec = nativeTerminalLaunchSpec(command, options, env);
  const childEnv = { ...process.env, ...env };
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: true,
    env: childEnv,
    stdio: "ignore",
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ launcher: spec.launcher, command: spec.command, args: spec.args });
    }, 700);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ launcher: spec.launcher, command: spec.command, args: spec.args });
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit ${code}`;
      reject(new Error(`native_terminal_launch_failed: ${suffix}`));
    });
  });
}
