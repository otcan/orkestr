import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  claudeCodeArgs,
  claudeCodeCommand,
  claudeCodeEventSessionId,
  claudeCodeEventTelemetry,
  claudeCodeEventText,
  claudeCodeExecutionEnv,
  claudeCodeMaxOutputBytes,
  claudeCodeStatusCapture,
  claudeCodeTimeoutMs,
  classifyClaudeCodeFailure,
  mergeClaudeCodeTelemetry,
  readClaudeCodeStatusTelemetry,
} from "./claude-code-client.js";
import { publicClaudeCodeFailure } from "./claude-code-runtime-policy.js";
import { spawnSupervised, supervisedProcessDefaults } from "./claude-code-supervised-process.js";
import { appendEvent } from "../../storage/src/store.js";
import { appHome } from "../../storage/src/paths.js";

function clean(value = "") {
  return String(value || "").trim();
}

function workspaceForThread(thread = {}) {
  return clean(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath) || process.cwd();
}

export function supervisionIdentityPath(threadId, env = process.env) {
  return path.join(appHome(env), "runtimes", "claude-code", "supervision", `${clean(threadId)}.json`);
}

export async function runClaudeCodeProcess({
  thread,
  profile,
  prompt,
  sessionId,
  priorTurnFailed = false,
  standingMission = "",
  attemptId,
  onPromptSubmitted = null,
  onEvent = null,
  onHeartbeat = null,
  assertProfileReady,
  activeTurns,
  env,
}) {
  const command = claudeCodeCommand(env);
  const childEnv = await claudeCodeExecutionEnv(profile, thread, env);
  const statusCapture = claudeCodeStatusCapture(profile, thread);
  await Promise.all([
    fs.mkdir(childEnv.HOME, { recursive: true, mode: 0o700 }),
    fs.mkdir(childEnv.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  await fs.mkdir(path.dirname(statusCapture.capturePath), { recursive: true, mode: 0o700 });
  await fs.rm(statusCapture.capturePath, { force: true });
  childEnv.ORKESTR_CLAUDE_STATUS_CAPTURE_PATH = statusCapture.capturePath;

  const identityFilePath = supervisionIdentityPath(thread.id, env);
  const defaults = supervisedProcessDefaults(env);
  return new Promise((resolve, reject) => {
    const supervisor = spawnSupervised({
      command,
      args: claudeCodeArgs(thread, { sessionId, priorTurnFailed, standingMission, statusCaptureCommand: statusCapture.command }, env),
      cwd: workspaceForThread(thread),
      env: childEnv,
      attemptId,
      identityFilePath,
      ...defaults,
      onToolTimeout({ toolName, elapsedMs }) {
        appendEvent({ type: "claude_code_tool_timeout", threadId: thread.id, attemptId, toolName, elapsedMs }, env).catch(() => {});
      },
      onHeartbeat,
    });
    activeTurns.set(thread.id, supervisor);

    let outputBytes = 0;
    let stderr = "";
    let resultText = "";
    let assistantText = "";
    let observedSessionId = sessionId;
    let resultError = "";
    let telemetry = {};
    let submissionPromise = Promise.resolve();
    const timeout = setTimeout(() => {
      if (!supervisor.settled) supervisor.terminate("claude_code_timeout");
    }, claudeCodeTimeoutMs(env));
    timeout.unref?.();

    function finish(error = null) {
      if (supervisor.settled) return;
      supervisor.markSettled(error?.code || null);
      clearTimeout(timeout);
      if (activeTurns.get(thread.id) === supervisor) activeTurns.delete(thread.id);
      supervisor.removeIdentityFile().catch(() => {});
      if (error) reject(error);
      else resolve({
        text: resultText || assistantText,
        sessionId: observedSessionId,
        interrupted: supervisor.interrupted,
        telemetry,
      });
    }

    const lines = readline.createInterface({ input: supervisor.proc.stdout });
    lines.on("line", (line) => {
      outputBytes += Buffer.byteLength(line) + 1;
      if (outputBytes > claudeCodeMaxOutputBytes(env)) {
        supervisor.terminate("claude_code_output_limit");
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch { return; }
      supervisor.observeEvent(event);
      onEvent?.(event);
      observedSessionId = claudeCodeEventSessionId(event) || observedSessionId;
      telemetry = mergeClaudeCodeTelemetry(telemetry, claudeCodeEventTelemetry(event));
      const text = claudeCodeEventText(event);
      if (clean(event.type).toLowerCase() === "result") {
        if (text) resultText = text;
        if (event.is_error === true || event.isError === true) resultError = clean(event.error || event.result || "claude_code_failed");
      } else if (text) assistantText = text;
    });
    supervisor.proc.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk || "")}`.slice(-8192);
    });
    supervisor.proc.on("error", (error) => finish(error));
    supervisor.proc.on("close", async (code, signal) => {
      lines.close();
      await submissionPromise;
      const statusTelemetry = await readClaudeCodeStatusTelemetry(statusCapture.capturePath);
      if (statusTelemetry) telemetry = mergeClaudeCodeTelemetry(telemetry, statusTelemetry);
      if (supervisor.interrupted) return finish();
      const failureCode = supervisor.failureCode ||
        (resultError ? classifyClaudeCodeFailure(resultError) : "") ||
        (code === 0 ? "" : classifyClaudeCodeFailure(stderr || `exit_${code}_${signal || ""}`));
      if (failureCode) {
        const error = new Error(failureCode);
        error.code = failureCode;
        error.telemetry = telemetry;
        return finish(error);
      }
      if (!observedSessionId) {
        const error = new Error("claude_code_session_missing");
        error.code = "claude_code_session_missing";
        return finish(error);
      }
      return finish();
    });
    supervisor.proc.stdin.on("error", () => {});
    submissionPromise = assertProfileReady()
      .then(async () => {
        supervisor.proc.stdin.end(`${String(prompt || "").replace(/\n*$/g, "")}\n`);
        await onPromptSubmitted?.();
      })
      .catch((error) => supervisor.terminate(publicClaudeCodeFailure(error)));
  });
}
