import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  claudeCodeArgs,
  claudeCodeCommand,
  claudeCodeEventBackgroundToolUse,
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
import {
  attachDetachedClaudeTurn,
  claudeCodeDetachedTurnsEnabled,
  spawnDetachedClaudeTurn,
} from "./claude-code-detached-turn.js";
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

function supervise({ thread, attemptId, spawnProcess, command = "", args = [], cwd, childEnv = {}, onHeartbeat, env }) {
  return spawnSupervised({
    command,
    args,
    cwd,
    env: childEnv,
    attemptId,
    identityFilePath: supervisionIdentityPath(thread.id, env),
    ...supervisedProcessDefaults(env),
    ...(spawnProcess ? { spawnProcess } : {}),
    onToolTimeout({ toolName, elapsedMs }) {
      appendEvent({ type: "claude_code_tool_timeout", threadId: thread.id, attemptId, toolName, elapsedMs }, env).catch(() => {});
    },
    onHeartbeat,
  });
}

export async function runClaudeCodeProcess({
  thread,
  profile,
  prompt,
  sessionId,
  priorTurnFailed = false,
  backgroundTaskRetry = false,
  standingMission = "",
  attemptId,
  messageId = "",
  rootTurnId = "",
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
  const args = claudeCodeArgs(thread, { sessionId, priorTurnFailed, backgroundTaskRetry, standingMission, statusCaptureCommand: statusCapture.command }, env);
  const detached = claudeCodeDetachedTurnsEnabled(env);
  if (detached) {
    // The detached process reads its prompt from a file, so the profile must
    // be confirmed ready before the prompt is handed over at spawn time.
    try {
      await assertProfileReady();
    } catch (error) {
      const failureCode = publicClaudeCodeFailure(error);
      const coded = new Error(failureCode);
      coded.code = failureCode;
      throw coded;
    }
  }
  const supervisor = supervise({
    thread,
    attemptId,
    command,
    args,
    cwd: workspaceForThread(thread),
    childEnv,
    onHeartbeat,
    env,
    spawnProcess: detached
      ? (spawnOptions) => spawnDetachedClaudeTurn({
        command: spawnOptions.command,
        args: spawnOptions.args,
        cwd: spawnOptions.cwd,
        childEnv: spawnOptions.env,
        prompt,
        threadId: thread.id,
        attemptId,
        meta: {
          messageId: clean(messageId),
          rootTurnId: clean(rootTurnId) || clean(attemptId),
          profileId: clean(profile?.id),
          sessionId: clean(sessionId),
          statusCapturePath: statusCapture.capturePath,
          timeoutMs: claudeCodeTimeoutMs(env),
        },
        env,
      })
      : null,
  });
  const submission = detached
    ? Promise.resolve().then(() => onPromptSubmitted?.()).catch(() => {})
    : null;
  return consumeSupervisedTurn({
    supervisor,
    thread,
    attemptId,
    sessionId,
    statusCapturePath: statusCapture.capturePath,
    timeoutMs: claudeCodeTimeoutMs(env),
    onEvent,
    activeTurns,
    env,
    submit: submission ? () => submission : () => assertProfileReady()
      .then(async () => {
        supervisor.proc.stdin.end(`${String(prompt || "").replace(/\n*$/g, "")}\n`);
        await onPromptSubmitted?.();
      })
      .catch((error) => supervisor.terminate(publicClaudeCodeFailure(error))),
  });
}

// Reattach to a detached turn left running (or finished) by a previous server
// process. The persisted event log is replayed to rebuild the turn state; lines
// already forwarded before the restart are not re-sent to `onEvent`.
export function attachClaudeCodeProcess({ thread, record, onEvent = null, onHeartbeat = null, activeTurns, env }) {
  const attemptId = clean(record.attemptId);
  const supervisor = supervise({
    thread,
    attemptId,
    onHeartbeat,
    env,
    spawnProcess: () => attachDetachedClaudeTurn(record, env),
  });
  const startedAt = Date.parse(record.startedAt || "") || Date.now();
  const totalTimeoutMs = Number(record.timeoutMs) > 0 ? Number(record.timeoutMs) : claudeCodeTimeoutMs(env);
  const promise = consumeSupervisedTurn({
    supervisor,
    thread,
    attemptId,
    sessionId: clean(record.sessionId),
    statusCapturePath: clean(record.statusCapturePath),
    timeoutMs: Math.max(1_000, totalTimeoutMs - (Date.now() - startedAt)),
    onEvent,
    activeTurns,
    env,
    submit: () => Promise.resolve(),
  });
  return { supervisor, promise };
}

function consumeSupervisedTurn({ supervisor, thread, attemptId, sessionId, statusCapturePath, timeoutMs, onEvent, activeTurns, env, submit }) {
  return new Promise((resolve, reject) => {
    activeTurns.set(thread.id, supervisor);

    let outputBytes = 0;
    let stderr = "";
    let resultText = "";
    let assistantText = "";
    let observedSessionId = sessionId;
    let resultError = "";
    let backgroundToolAttempt = "";
    let telemetry = {};
    let resultSucceeded = false;
    let completedDuringInterrupt = false;
    let submissionPromise = Promise.resolve();
    const timeout = setTimeout(() => {
      if (!supervisor.settled) supervisor.terminate("claude_code_timeout");
    }, timeoutMs);
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
        interrupted: supervisor.interrupted && !completedDuringInterrupt,
        telemetry,
        transport: supervisor.transport,
      });
    }

    function handleLine(line, meta = {}) {
      outputBytes += Buffer.byteLength(line) + 1;
      if (outputBytes > claudeCodeMaxOutputBytes(env)) {
        supervisor.terminate("claude_code_output_limit");
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch { return; }
      supervisor.observeEvent(event);
      if (!meta.replay) onEvent?.(event);
      if (!backgroundToolAttempt) backgroundToolAttempt = claudeCodeEventBackgroundToolUse(event);
      observedSessionId = claudeCodeEventSessionId(event) || observedSessionId;
      telemetry = mergeClaudeCodeTelemetry(telemetry, claudeCodeEventTelemetry(event));
      const text = claudeCodeEventText(event);
      if (clean(event.type).toLowerCase() === "result") {
        if (text) resultText = text;
        if (event.is_error === true || event.isError === true) resultError = clean(event.error || event.result || "claude_code_failed");
        else resultSucceeded = true;
      } else if (text) assistantText = text;
    }

    const lines = typeof supervisor.proc.onLine === "function"
      ? (supervisor.proc.onLine(handleLine), { close() {} })
      : readline.createInterface({ input: supervisor.proc.stdout }).on("line", (line) => handleLine(line));
    supervisor.proc.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk || "")}`.slice(-8192);
    });
    supervisor.proc.on("error", (error) => finish(error));
    supervisor.proc.on("close", async (code, signal) => {
      lines.close();
      await submissionPromise;
      const statusTelemetry = await readClaudeCodeStatusTelemetry(statusCapturePath);
      if (statusTelemetry) telemetry = mergeClaudeCodeTelemetry(telemetry, statusTelemetry);
      // A graceful interrupt that raced a turn already emitting its successful
      // result is a natural completion: keep the answer instead of discarding it.
      completedDuringInterrupt = supervisor.interrupted && supervisor.interruptMode === "graceful" &&
        resultSucceeded && Boolean(resultText || assistantText) && Boolean(observedSessionId);
      if (supervisor.interrupted && !completedDuringInterrupt) return finish();
      // A detected background-task attempt overrides an otherwise-clean exit:
      // the turn's own result text may claim it will keep working or notify
      // later, which this headless process can never honor once it exits.
      // Reject the turn instead of finalizing that false completion; the
      // standard failed-turn path (below) already retries on the next input.
      const failureCode = supervisor.failureCode ||
        (resultError ? classifyClaudeCodeFailure(resultError) : "") ||
        (code === 0 || completedDuringInterrupt ? "" : classifyClaudeCodeFailure(stderr || `exit_${code}_${signal || ""}`)) ||
        (backgroundToolAttempt ? "claude_code_background_task_attempted" : "");
      if (failureCode) {
        if (failureCode === "claude_code_background_task_attempted") {
          appendEvent({
            type: "claude_code_background_task_blocked",
            threadId: thread.id,
            attemptId,
            toolName: backgroundToolAttempt,
          }, env).catch(() => {});
        }
        const error = new Error(failureCode);
        error.code = failureCode;
        error.telemetry = telemetry;
        // An automatic retry needs the session the offending turn was
        // actually running under (captured from its own init event) so it
        // resumes the same transcript instead of starting a fresh one.
        if (failureCode === "claude_code_background_task_attempted") error.sessionId = observedSessionId;
        if (supervisor.failureCode) {
          // Orkestr stopped the turn itself; keep what a kill notice and a
          // later "continue" need (the session transcript holds partial work).
          const toolTimeout = supervisor.toolTimeout;
          error.sessionId = observedSessionId;
          error.termination = {
            toolName: toolTimeout?.toolName || supervisor.currentToolName || "",
            toolElapsedMs: toolTimeout?.elapsedMs ?? supervisor.toolElapsedMs,
            turnElapsedMs: Date.now() - supervisor.startedAt,
            userInterrupted: supervisor.interrupted,
          };
        }
        return finish(error);
      }
      if (!observedSessionId) {
        const error = new Error("claude_code_session_missing");
        error.code = "claude_code_session_missing";
        return finish(error);
      }
      return finish();
    });
    supervisor.proc.stdin?.on?.("error", () => {});
    submissionPromise = submit();
  });
}
