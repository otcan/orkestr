// Claude Code job executor (docs/spec/adapter-interface.md §4). Implements the
// native executor interface (agent-job-native-interface.js).
//
// Runs one Agent Job attempt as `claude -p --output-format stream-json` in the
// run's workspace (ctx.prepareWorkspace), without a thread record:
// * every tool call passes a PreToolUse hook (agent-job-claude-permission-hook.js)
//   that asks ctx.authorizeTool through a per-attempt broker, so the job's
//   allow / approval_required / deny lists are enforced per call
//   (permissionHook "pre_call"). A tool result for a call that never passed
//   the hook stops the attempt (fail closed);
// * assistant text, tool calls and tool results are emitted as progress
//   events (the runner writes them into the run journal);
// * the session id is emitted before any tool runs, so a later attempt
//   resumes ctx.resume.sessionRef (`--resume`) after a crash or an approval wait;
// * ctx.signal (cancel, timeout, lost lease) kills the process group.
//
// It uses the host Claude login, the same one the provider probe checks.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { nativeAttemptError, nativeExecutorEnabled, nativeTimeoutError } from "./agent-job-native-interface.js";
import { startPermissionBroker } from "./agent-job-permission-broker.js";
import { claudeCodeCommand, claudeCodeEventSessionId, claudeCodeEventText, classifyClaudeCodeFailure } from "./claude-code-client.js";
import { classifyClaudeCodeFailureCode, turnErrorClassification } from "./runtime-turn-error-class.js";

const HOOK_SCRIPT = fileURLToPath(new URL("./agent-job-claude-permission-hook.js", import.meta.url));
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CLAUDE_CONFIG_DIR"];

const JOB_NOTICE = [
  "You are running an Orkestr Agent Job attempt in a headless process; no person is watching this session.",
  "Every tool call is checked against the job's tool policy before it runs. A blocked call is final for this attempt: do not try to work around it with other tools.",
  "When a call is blocked because it needs approval, stop and end your turn; Orkestr resumes this session after a person decides.",
  "Do not start background tasks. Finish with the final answer only.",
].join("\n");

function clean(value) {
  return String(value ?? "").trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function claudeJobSettings() {
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(HOOK_SCRIPT)}`, timeout: 3600 }] }],
    },
  };
}

export function claudeJobArgs(input = {}) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    // The hook decides every call; anything it does not allow is not run.
    "--permission-mode", "default",
    "--settings", JSON.stringify(claudeJobSettings()),
    // No MCP servers from user or project config: the job's tools are the
    // Claude built-ins, each gated by the hook.
    "--strict-mcp-config",
    "--append-system-prompt", JOB_NOTICE,
  ];
  if (/^[a-zA-Z0-9._:-]{1,120}$/.test(clean(input.model))) args.push("--model", clean(input.model));
  if (clean(input.resumeSessionRef)) args.push("--resume", clean(input.resumeSessionRef));
  return args;
}

function childEnv(env, broker) {
  const source = { ...process.env, ...env };
  const result = { HOME: clean(env.HOME) || os.homedir() };
  for (const key of INHERITED_ENV) if (source[key] !== undefined) result[key] = source[key];
  return {
    ...result,
    DISABLE_AUTOUPDATER: "1",
    // Nothing reaps a backgrounded task once this headless process exits.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    ...broker.env,
  };
}

export function claudeJobPrompt(input = {}) {
  if (clean(input.resumeSessionRef)) {
    return [
      `Orkestr resumed this job (${clean(input.resumeReason) || "new attempt"}).`,
      "Continue the original task from where you stopped. If a tool call was blocked for approval, retry it only if it is still needed: Orkestr now applies the person's decision.",
      input.resumeSummary ? `\nAlready committed effects:\n${input.resumeSummary}` : "",
      input.outputSchema ? `\nEnd with only a JSON value matching this schema:\n${JSON.stringify(input.outputSchema)}` : "",
    ].join("\n").trim();
  }
  return [
    input.prompt,
    input.resumeSummary ? `\n\nResume context:\n${input.resumeSummary}` : "",
    Object.keys(input.inputs || {}).length ? `\n\nInputs:\n${JSON.stringify(input.inputs, null, 2)}` : "",
    input.triggerEvent ? `\n\nTrigger event:\n${JSON.stringify(input.triggerEvent, null, 2)}` : "",
    input.outputSchema ? `\n\nEnd with only a JSON value matching this schema:\n${JSON.stringify(input.outputSchema)}` : "",
  ].join("");
}

// The final answer: JSON when the job declares an output schema (a bare value
// or a ```json fence), otherwise { text }.
export function claudeJobOutput(text, outputSchema) {
  const value = clean(text);
  if (!outputSchema) return { text: value };
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(value)?.[1];
  for (const candidate of [value, fenced]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  return { text: value };
}

// Low-cardinality Claude failure code -> turn error class
// (runtime-turn-error-class.js) and the runner's kind/retryable. A killed
// process is retried; a missing CLI is an install problem, so it is a provider
// error (fallback applies) rather than a task error.
export function claudeJobError(code, { sessionRef = "" } = {}) {
  const classification = code === "claude_code_interrupted"
    ? turnErrorClassification("transient", code)
    : classifyClaudeCodeFailureCode(code);
  const error = nativeAttemptError(classification, { message: code, sessionRef });
  if (code === "claude_code_cli_missing" || code === "claude_code_permission_hook_bypassed") error.kind = "provider";
  return error;
}

function contentBlocks(event) {
  const content = event?.message?.content ?? event?.content;
  return Array.isArray(content) ? content.filter((block) => block && typeof block === "object") : [];
}

function rejectedBeforeHook(block) {
  const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
  return block.is_error === true && content.includes("<tool_use_error>");
}

function killGroup(proc, signal) {
  try { process.kill(-proc.pid, signal); } catch {
    try { proc.kill(signal); } catch {}
  }
}

async function runClaudeJobAttempt(ctx, jobInput) {
  const workspace = await ctx.prepareWorkspace(jobInput);
  await fs.chmod(workspace.path, 0o700).catch(() => {});
  ctx.emit({ type: "workspace.ready", path: workspace.path, kind: workspace.kind });
  const input = { ...jobInput, resumeSessionRef: clean(ctx.resume?.sessionRef), resumeReason: clean(ctx.resume?.reason) };
  let stop = null; // { kind: "park"|"expired"|"cancelled"|"bypass"|"aborted", approval?, reason? }
  let proc = null;
  const toolsById = new Map();
  const toolUseNames = new Map(); // tool_use id -> provider tool name

  function terminate(reason) {
    if (!stop) stop = reason;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    killGroup(proc, "SIGTERM");
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) killGroup(proc, "SIGKILL"); }, KILL_GRACE_MS).unref?.();
  }

  const broker = await startPermissionBroker({
    async authorize({ tool, args, callId }) {
      if (stop) return { decision: "deny", reason: "the Orkestr job attempt is stopping" };
      toolsById.set(callId, tool);
      ctx.emit({ type: "tool.requested", callId, tool });
      const verdict = await ctx.authorizeTool({ tool, args, callId });
      if (verdict?.decision === "allow") return { decision: "allow" };
      if (verdict?.decision === "pending") {
        terminate({ kind: "park", approval: verdict.approval });
        return { decision: "deny", reason: `${tool} needs approval (Orkestr approval ${verdict.approval?.approvalId || ""}); the job is paused until a person decides. Stop now.` };
      }
      if (verdict?.decision === "expired") {
        terminate({ kind: "expired", approval: verdict.approval });
        return { decision: "deny", reason: `the approval for ${tool} expired` };
      }
      if (verdict?.decision === "cancelled") {
        terminate({ kind: "cancelled" });
        return { decision: "deny", reason: "the job run was cancelled" };
      }
      return { decision: "deny", reason: verdict?.reason || `${tool} is denied by the Orkestr job policy` };
    },
  });

  const onAbort = () => terminate({ kind: ctx.signal.reason === "cancelled" ? "cancelled" : "aborted", reason: String(ctx.signal.reason || "aborted") });
  try {
    proc = spawn(claudeCodeCommand(ctx.env), claudeJobArgs(input), {
      cwd: workspace.path,
      env: childEnv(ctx.env, broker),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (ctx.signal?.aborted) onAbort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    let sessionRef = clean(input.resumeSessionRef);
    let sessionAnnounced = false;
    let resultText = "";
    let lastText = "";
    let resultError = "";
    let stderr = "";
    let outputBytes = 0;

    const handleEvent = (event) => {
      const observed = claudeCodeEventSessionId(event);
      if (observed) sessionRef = observed;
      if (sessionRef && !sessionAnnounced) {
        sessionAnnounced = true;
        ctx.emit({ type: "session.started", sessionRef, resumed: sessionRef === input.resumeSessionRef });
      }
      const type = clean(event.type).toLowerCase();
      if (type === "result") {
        resultText = claudeCodeEventText(event) || resultText;
        if (event.is_error === true || event.isError === true) resultError = clean(event.error || event.result) || "claude_code_failed";
        const usage = event.usage || {};
        if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
          ctx.emit({ type: "usage", inputTokens: Number(usage.input_tokens || 0), outputTokens: Number(usage.output_tokens || 0), costUsd: event.total_cost_usd ?? undefined });
        }
        return;
      }
      if (type === "assistant") {
        for (const block of contentBlocks(event)) {
          if (clean(block.type) === "tool_use" && block.id) toolUseNames.set(clean(block.id), clean(block.name));
        }
        const text = claudeCodeEventText(event);
        if (text) {
          lastText = text;
          ctx.emit({ type: "message.completed", text });
        }
        return;
      }
      if (type !== "user") return;
      for (const block of contentBlocks(event)) {
        if (clean(block.type) !== "tool_result") continue;
        const callId = clean(block.tool_use_id);
        // A tool ran without passing the Orkestr hook. Calls Claude rejected
        // itself before any hook (invalid input) are reported as tool_use_error.
        const decision = broker.decisionFor(callId, toolUseNames.get(callId) || "");
        if (!decision && !rejectedBeforeHook(block)) {
          terminate({ kind: "bypass", reason: callId || "unknown_call" });
          return;
        }
        ctx.emit({ type: "tool.completed", callId, tool: toolsById.get(callId) || "", ok: decision === "allow" && block.is_error !== true });
      }
    };

    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      outputBytes += Buffer.byteLength(line) + 1;
      if (outputBytes > MAX_OUTPUT_BYTES) return terminate({ kind: "error", reason: "claude_code_output_limit" });
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event && typeof event === "object") handleEvent(event);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    proc.stdin.on("error", () => {});
    proc.stdin.end(`${claudeJobPrompt(input).replace(/\n*$/, "")}\n`);

    const { code, signal } = await new Promise((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    }).catch((error) => {
      throw claudeJobError(error?.code === "ENOENT" ? "claude_code_cli_missing" : classifyClaudeCodeFailure(error?.message));
    });

    if (stop?.kind === "park") return { type: "park", approval: stop.approval, sessionRef };
    if (stop?.kind === "expired") return { type: "expired", approval: stop.approval, sessionRef };
    if (stop?.kind === "cancelled") return { type: "cancelled", sessionRef };
    // The runner maps a lost lease from ctx.signal itself.
    if (stop?.kind === "aborted") {
      if (stop.reason === "timeout") throw nativeTimeoutError();
      return { type: "cancelled", sessionRef };
    }
    if (stop?.kind === "bypass") throw claudeJobError("claude_code_permission_hook_bypassed", { sessionRef });
    if (stop?.kind === "error") throw claudeJobError(stop.reason, { sessionRef });
    if (resultError) throw claudeJobError(classifyClaudeCodeFailure(resultError), { sessionRef });
    if (code !== 0) throw claudeJobError(classifyClaudeCodeFailure(stderr || `exit_${code}_${signal || ""}`), { sessionRef });
    if (!sessionRef) throw claudeJobError("claude_code_session_missing");
    return { type: "final", output: claudeJobOutput(resultText || lastText, input.outputSchema), sessionRef };
  } finally {
    ctx.signal?.removeEventListener?.("abort", onAbort);
    await broker.close();
  }
}

export const claudeCodeJobAdapter = Object.freeze({
  id: "claude-code",
  jobExecutor: "claude-code-cli",
  enabled: (env = process.env) => nativeExecutorEnabled("claude-code", env),
  capabilities: Object.freeze({
    toolLoop: "native",
    resume: "session",
    interrupt: "kill",
    streaming: true,
    structuredOutput: "validate",
    permissionHook: "pre_call",
    sandbox: "workspace_write",
    usage: true,
  }),
  async probe() {
    return { ok: true };
  },
  run: runClaudeJobAttempt,
});
