import { spawn } from "node:child_process";

// Keystroke backend for managed desktops (used by vault fill, docs/vault.md).
// Types text into whatever has keyboard focus on the desktop's X display with
// `xdotool`. Secret text is written to the typing process's stdin
// (`type --file -`), never passed as argv or environment, and the clipboard is
// never used. Only DISPLAY and PATH are passed to the child; its output is
// discarded so nothing typed can reach logs.

const KEY_NAMES = new Set(["Tab", "Return"]);
const DEFAULT_TIMEOUT_MS = 20_000;

function clean(value) {
  return String(value ?? "").trim();
}

export function keystrokeCommand(env = process.env) {
  return clean(env.ORKESTR_DESKTOP_KEYSTROKE_COMMAND) || "xdotool";
}

/** X display (":N") of a managed desktop session, or "" when unknown. */
export function desktopDisplay(session = {}) {
  const display = clean(session?.display);
  return /^:\d{1,5}(?:\.\d{1,3})?$/.test(display) ? display : "";
}

function run(command, args, { display, stdin = null, env, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(command, args, {
      env: { DISPLAY: display, PATH: clean(env.PATH) || "/usr/bin:/bin" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("exit", (code, signal) => finish(!signal && code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

/**
 * Runs keystroke steps on a display: `{ text }` types text from stdin,
 * `{ key: "Tab" | "Return" }` presses a key. Returns true when every step
 * succeeded; never throws with or returns the typed text.
 */
export async function typeIntoDesktop(display, steps = [], env = process.env) {
  if (!/^:\d/.test(clean(display))) return false;
  const command = keystrokeCommand(env);
  const timeoutMs = Number(env.ORKESTR_DESKTOP_KEYSTROKE_TIMEOUT_MS) > 0 ? Number(env.ORKESTR_DESKTOP_KEYSTROKE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  for (const step of steps) {
    let ok;
    if (typeof step?.text === "string") {
      ok = await run(command, ["type", "--clearmodifiers", "--delay", "20", "--file", "-"], { display, stdin: step.text, env, timeoutMs });
    } else if (KEY_NAMES.has(step?.key)) {
      ok = await run(command, ["key", "--clearmodifiers", step.key], { display, env, timeoutMs });
    } else {
      ok = false;
    }
    if (!ok) return false;
  }
  return true;
}
