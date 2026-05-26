import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDataDirs } from "../../storage/src/paths.js";

const execFileAsync = promisify(execFile);

export function compactLabel(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tmuxWindowNameForLabel(value) {
  const label = compactLabel(value || "Orkestr");
  return Array.from(label).slice(0, 48).join("") || "Orkestr";
}

export async function tmuxHasSession(sessionName) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxNewSession(sessionName, workspace, command, options = {}) {
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-c", workspace, command], options);
}

export async function tmuxPaneId(sessionName) {
  return (await tmuxPaneIds(sessionName))[0] || null;
}

export async function tmuxPaneIds(sessionName) {
  const target = String(sessionName || "").trim();
  if (!target) return [];
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"]);
  return String(stdout || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function tmuxPaneProcessIds(sessionName) {
  const target = String(sessionName || "").trim();
  if (!target) return [];
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", target, "-F", "#{pane_pid}"]);
  return String(stdout || "")
    .trim()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
}

async function terminateProcessTreeRoots(pids = [], signal = "SIGTERM") {
  const terminated = [];
  for (const pid of [...new Set(pids)]) {
    try {
      process.kill(-pid, signal);
      terminated.push({ pid, signal, target: "process_group" });
      continue;
    } catch {
      // Fall back to the direct pane process. Some tmux pane commands are not
      // process-group leaders.
    }
    try {
      process.kill(pid, signal);
      terminated.push({ pid, signal, target: "process" });
    } catch {
      // The process may already be gone after tmux killed the pane.
    }
  }
  return terminated;
}

export async function killTmuxSession(sessionName, { killProcessGroup = true } = {}) {
  const target = String(sessionName || "").trim();
  if (!target) return { sessionName: target, panePids: [], terminated: [] };
  const panePids = killProcessGroup ? await tmuxPaneProcessIds(target).catch(() => []) : [];
  await execFileAsync("tmux", ["kill-session", "-t", target]).catch(() => {});
  const terminated = killProcessGroup ? await terminateProcessTreeRoots(panePids) : [];
  return { sessionName: target, panePids, terminated };
}

export async function renameTmuxWindow(sessionName, windowName) {
  const target = String(sessionName || "").trim();
  const name = compactLabel(windowName);
  if (!target || !name) return;
  await execFileAsync("tmux", ["set-window-option", "-t", target, "automatic-rename", "off"]).catch(() => {});
  await execFileAsync("tmux", ["set-window-option", "-t", target, "allow-rename", "off"]).catch(() => {});
  await execFileAsync("tmux", ["rename-window", "-t", target, name]);
}

export async function capturePane(paneId, lines = 80) {
  if (!paneId) return "";
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", `-${Math.max(20, lines)}`]);
  return String(stdout || "");
}

export async function pasteTmuxText(paneId, text, env = process.env) {
  const paths = await ensureDataDirs(env);
  const bufferName = `orkestr-${crypto.randomBytes(8).toString("hex")}`;
  const pastePath = path.join(paths.home, `${bufferName}.txt`);
  await fs.writeFile(pastePath, String(text || ""), "utf8");
  try {
    await execFileAsync("tmux", ["load-buffer", "-b", bufferName, pastePath]);
    await execFileAsync("tmux", ["paste-buffer", "-b", bufferName, "-t", paneId]);
  } finally {
    await execFileAsync("tmux", ["delete-buffer", "-b", bufferName]).catch(() => {});
    await fs.unlink(pastePath).catch(() => {});
  }
}

export async function tmuxSendKeys(paneId, ...keys) {
  const target = String(paneId || "").trim();
  if (!target || !keys.length) return;
  await execFileAsync("tmux", ["send-keys", "-t", target, ...keys]);
}

export function tmuxInlineCharLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_TMUX_INLINE_CHAR_LIMIT || 800);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 800;
}
