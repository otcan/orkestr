// `codex` provider for Agent Jobs: one attempt = one turn on a Codex
// app-server session that belongs to the run (codex-job-session.js), with no
// Orkestr chat thread behind it. Implements the native executor interface
// (agent-job-native-interface.js).
//
// * Workspace: ctx.prepareWorkspace() (a per-run directory, or a detached git
//   worktree for repository jobs). Codex runs there with sandbox
//   `workspace-write` and approval policy `untrusted`.
// * Orkestr tools permitted by the job are exposed to Codex as dynamic tools;
//   every call runs through ctx.executeTool (tool decision + effect ledger).
// * Codex's own approval requests (commands, file changes, extra permissions,
//   MCP tool calls) are mapped to the job tools `codex.command`,
//   `codex.file_change`, `codex.permissions` and `codex.mcp` and decided by
//   ctx.authorizeTool (`permissions.tools`, default deny). A pending approval
//   interrupts the turn and parks the run; the next attempt resumes the same
//   Codex session and the approval is consumed once.
// * Progress (agent messages, tool items) goes through ctx.emit.
// * Cancellation and timeouts interrupt the turn (`turn/interrupt`).
// * Resume: the Codex thread id is emitted as `session.started`; a later
//   attempt, also after a process restart, resumes ctx.resume.sessionRef with
//   `thread/resume`.
// * Output: the final message is parsed as JSON and validated against
//   `task.output_schema`; an invalid answer is re-asked once.
import { validateOutput } from "./agent-job-output.js";
import { approvedCallsText, nativeAttemptError, nativeExecutorEnabled, nativeTimeoutError } from "./agent-job-native-interface.js";
import { getAgentJobTool, listAgentJobTools } from "./agent-job-tools.js";
import { CodexJobSession, classifyCodexJobError } from "./codex-job-session.js";

export const CODEX_NATIVE_TOOLS = Object.freeze(["codex.command", "codex.file_change", "codex.permissions", "codex.mcp"]);

// Dynamic tool names must be plain identifiers: repo.branch.push -> repo__branch__push.
export const codexToolName = (name) => String(name).replace(/\./g, "__");

function exposedTools(ctx) {
  return listAgentJobTools()
    .map((tool) => tool.name)
    .filter((name) => !CODEX_NATIVE_TOOLS.includes(name) && ctx.toolDecision(name) !== "deny");
}

function dynamicToolSpecs(names) {
  return names.map((name) => ({
    type: "function",
    name: codexToolName(name),
    description: getAgentJobTool(name)?.description || `Orkestr job tool ${name}. Side effects are recorded and may need approval.`,
    inputSchema: { type: "object", additionalProperties: true },
  }));
}

function outputInstruction(schema) {
  return schema
    ? `Finish with a final message that is only a JSON value matching this JSON Schema:\n${JSON.stringify(schema)}`
    : "Finish with a short final message summarizing the result (a JSON object is preferred).";
}

function developerInstructions(ctx, workspace) {
  return [
    `You are running an unattended Orkestr Agent Job (job ${ctx.job}, run ${ctx.runId}). Nobody watches this turn.`,
    `Work inside ${workspace.path}. External actions (pushing branches, pull requests, messages, network) must use the provided Orkestr tools.`,
    "Commands and file changes may be denied by the job permissions. If a tool result says the run is paused for approval, end your turn.",
  ].join("\n");
}

function firstPrompt(input) {
  return [
    input.prompt,
    Object.keys(input.inputs || {}).length ? `Inputs:\n${JSON.stringify(input.inputs, null, 2)}` : "",
    input.triggerEvent ? `Trigger event:\n${JSON.stringify(input.triggerEvent, null, 2)}` : "",
    input.resumeSummary ? `Already completed in earlier attempts (do not repeat):\n${input.resumeSummary}` : "",
    outputInstruction(input.outputSchema),
  ].filter(Boolean).join("\n\n");
}

function resumePrompt(input, resume) {
  return [
    `This Agent Job run is resuming in the same session (${resume.reason}). Continue the task from where it stopped.`,
    "Approvals decided since then apply now: retry an action that was paused for approval if it is still needed.",
    approvedCallsText(input),
    input.resumeSummary ? `Completed actions (do not repeat):\n${input.resumeSummary}` : "",
    outputInstruction(input.outputSchema),
  ].filter(Boolean).join("\n\n");
}

export function parseCodexFinalOutput(text) {
  const raw = String(text || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {}
  return { text: raw };
}

// Translate a Codex approval request into a job tool call, or null.
function nativeCall({ method, params, item }) {
  if (method === "item/commandExecution/requestApproval") {
    const command = params.command ?? item?.command ?? "";
    return { tool: "codex.command", args: { command: Array.isArray(command) ? command.join(" ") : String(command), cwd: params.cwd || item?.cwd || null }, kind: "decision" };
  }
  if (method === "item/fileChange/requestApproval") {
    const changes = (Array.isArray(item?.changes) ? item.changes : []).map((change) => ({ path: change.path, kind: change.kind?.type || change.kind || null }));
    return { tool: "codex.file_change", args: { changes, grantRoot: params.grantRoot || null }, kind: "decision" };
  }
  if (method === "item/permissions/requestApproval") return { tool: "codex.permissions", args: { permissions: params.permissions || {} }, kind: "permissions" };
  if (method === "mcpServer/elicitation/request") return { tool: "codex.mcp", args: { server: params.serverName || "", message: params.message || "" }, kind: "elicitation" };
  return null;
}

function nativeResponse(kind, granted, params = {}) {
  if (kind === "permissions") return { result: granted ? { permissions: params.permissions || {}, scope: "turn" } : { permissions: {} } };
  if (kind === "elicitation") return { result: { action: granted ? "accept" : "decline", content: null } };
  return { result: { decision: granted ? "accept" : "decline" } };
}

const GRANTED = new Set(["ok", "committed", "reconciled"]);
const STOPS = new Set(["park", "expired", "cancelled"]);
// ctx.authorizeTool decisions that stop the attempt.
const STOP_DECISIONS = Object.freeze({ pending: "park", expired: "expired", cancelled: "cancelled" });

function progressEvent(event) {
  if (event.type === "message") return { type: "message.completed", text: event.text };
  const done = ["completed", "failed", "declined"].includes(event.status);
  return { type: done ? "tool.completed" : "tool.requested", tool: event.tool || event.itemType, callId: event.itemId, ok: event.status === "completed" };
}

function toolText(status, result) {
  if (status === "park") return "Paused: this action needs an approval. The run is parked; end your turn now.";
  if (status === "deduplicated" || status === "reconciled" || GRANTED.has(status)) return JSON.stringify({ status, result: result.result ?? null, ref: result.ref ?? null });
  return JSON.stringify({ status, error: result.error || status });
}

async function runTurn(ctx, session, text, stopRef) {
  const handlers = {
    signal: ctx.signal,
    onEvent: (event) => ctx.emit(progressEvent(event)),
    async onServerRequest(request) {
      if (stopRef.stop) return { error: "The Orkestr job attempt is stopping." };
      let call = null;
      if (request.method === "item/tool/call") {
        const name = String(request.params.tool || "");
        const tool = listAgentJobTools().map((candidate) => candidate.name).find((candidate) => codexToolName(candidate) === name) || name;
        call = { tool, args: request.params.arguments && typeof request.params.arguments === "object" ? request.params.arguments : {}, kind: "dynamic" };
      } else {
        call = nativeCall(request);
      }
      if (!call) return { error: `Not available in unattended Orkestr jobs: ${request.method}` };
      if (call.kind !== "dynamic") {
        // The tool-permission hook; a granted approval is single use.
        const verdict = await ctx.authorizeTool({ tool: call.tool, args: call.args, callId: request.params?.itemId || "" });
        if (STOP_DECISIONS[verdict?.decision]) {
          stopRef.stop = { type: STOP_DECISIONS[verdict.decision], approval: verdict.approval || null };
          await session.interrupt();
        }
        return nativeResponse(call.kind, verdict?.decision === "allow", request.params);
      }
      let result;
      try {
        result = await ctx.executeTool({ tool: call.tool, args: call.args });
      } catch (error) {
        // Crash or lost lease: stop like a dead process, without answering.
        stopRef.stop = { crash: error };
        session.failTurn(error);
        return { noReply: true };
      }
      if (STOPS.has(result.status)) {
        stopRef.stop = { type: result.status, approval: result.approval || null };
        await session.interrupt();
      }
      const success = GRANTED.has(result.status) || result.status === "deduplicated";
      return { result: { success, contentItems: [{ type: "inputText", text: toolText(result.status, result) }] } };
    },
  };
  const turn = await session.runTurn({ inputId: `${ctx.runId}:a${ctx.attempt}:${stopRef.turns++}`, text }, handlers);
  if (stopRef.stop?.crash) throw stopRef.stop.crash;
  return turn;
}

export const codexJobAdapter = Object.freeze({
  id: "codex",
  jobExecutor: "codex-app-server",
  enabled: (env = process.env) => nativeExecutorEnabled("codex", env),
  capabilities: Object.freeze({
    toolLoop: "native",
    resume: "session",
    interrupt: "cooperative",
    streaming: true,
    structuredOutput: "validate",
    permissionHook: "pre_call",
    sandbox: "workspace_write",
    usage: false,
  }),
  async probe() {
    return { ok: true };
  },
  async run(ctx, input) {
    const workspace = await ctx.prepareWorkspace(input);
    ctx.emit({ type: "workspace.ready", path: workspace.path, kind: workspace.kind });
    const session = new CodexJobSession({ env: ctx.env });
    const stopRef = { stop: null, turns: 0 };
    try {
      const opened = await session.open({
        sessionRef: ctx.resume?.sessionRef || "",
        cwd: workspace.path,
        model: input.model || "",
        developerInstructions: developerInstructions(ctx, workspace),
        dynamicTools: dynamicToolSpecs(exposedTools(ctx)),
      });
      ctx.emit({ type: "session.started", sessionRef: opened.sessionRef, resumed: opened.resumed });
      ctx.fault("codex_session_started");
      let text = opened.resumed ? resumePrompt(input, ctx.resume || { reason: "after an interruption" }) : firstPrompt(input);
      for (let repairs = 0; ; repairs += 1) {
        const turn = await runTurn(ctx, session, text, stopRef);
        if (stopRef.stop) return { type: stopRef.stop.type, approval: stopRef.stop.approval };
        if (turn.status === "cancelled") {
          if (ctx.signal?.reason === "timeout") throw nativeTimeoutError();
          return { type: "cancelled" };
        }
        if (turn.status === "failed") throw nativeAttemptError(turn.error, { message: turn.error?.message || "codex_turn_failed", sessionRef: opened.sessionRef });
        const output = parseCodexFinalOutput(turn.finalText);
        const invalid = input.outputSchema ? validateOutput(input.outputSchema, output) : null;
        if (!invalid || repairs >= 1) return { type: "final", output };
        ctx.emit({ type: "output.repair", error: String(invalid) });
        text = `Your final answer did not match the output schema (${invalid}). Reply with only the corrected JSON value.`;
      }
    } catch (error) {
      if (error?.kind || error?.injectedCrash || error?.leaseLost) throw error;
      // Failures outside a turn (spawn, transport, RPC) are provider errors.
      const message = String(error?.message || error);
      throw Object.assign(nativeAttemptError(classifyCodexJobError(message), { message }), { kind: "provider" });
    } finally {
      session.close();
    }
  },
});
