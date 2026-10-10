// `codex` provider for Agent Jobs: one attempt = one turn on a Codex
// app-server session that belongs to the run (codex-job-session.js), with no
// Orkestr chat thread behind it.
//
// * Workspace: a per-run directory, or a detached git worktree for repository
//   jobs (agent-job-workspace.js). Codex runs there with sandbox
//   `workspace-write` and approval policy `untrusted`.
// * Orkestr tools permitted by the job are exposed to Codex as dynamic tools;
//   every call runs through the runner's tool decision and effect ledger.
// * Codex's own approval requests (commands, file changes, extra permissions,
//   MCP tool calls) are mapped to the job tools `codex.command`,
//   `codex.file_change`, `codex.permissions` and `codex.mcp` and decided by
//   `permissions.tools` (default deny). `approval_required` creates a runner
//   approval, interrupts the turn and parks the run; the next attempt resumes
//   the same Codex session and the approval is consumed once.
// * Progress (agent messages, tool items) is journaled as checkpoints.
// * Cancellation and timeouts interrupt the turn (`turn/interrupt`).
// * Resume: the Codex thread id is journaled (`codex_session`); a later
//   attempt, also after a process restart, resumes it with `thread/resume`.
// * Output: the final message is parsed as JSON and validated against
//   `task.output_schema`; an invalid answer is re-asked once.
import { validateOutput } from "./agent-job-output.js";
import { getAgentJobTool, listAgentJobTools, registerAgentJobTool } from "./agent-job-tools.js";
import { prepareAgentJobWorkspace } from "./agent-job-workspace.js";
import { CodexJobSession, codexJobErrorFields } from "./codex-job-session.js";

export const CODEX_NATIVE_TOOLS = Object.freeze(["codex.command", "codex.file_change", "codex.permissions", "codex.mcp"]);

const keyOf = (value) => JSON.stringify(value ?? null);
// Codex-native calls are not ledgered when allowed (they stay inside the
// workspace sandbox); `approval_required` binds the approval to these args.
for (const [name, logical] of [
  ["codex.command", (args) => [args.command, args.cwd]],
  ["codex.file_change", (args) => [keyOf(args.changes)]],
  ["codex.permissions", (args) => [keyOf(args.permissions)]],
  ["codex.mcp", (args) => [args.server, args.message]],
]) {
  registerAgentJobTool({ name, effect: false, logicalKey: logical, async perform() { return { result: { granted: true } }; } });
}

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

function resumePrompt(input, previous) {
  return [
    `This Agent Job run is resuming in the same session (attempt ${previous.attempt} ended: ${previous.reason}). Continue the task from where it stopped.`,
    "Approvals decided since then apply now: retry an action that was paused for approval if it is still needed.",
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

function nativeResponse(kind, granted, params) {
  if (kind === "permissions") return { result: granted ? { permissions: params.permissions || {}, scope: "turn" } : { permissions: {} } };
  if (kind === "elicitation") return { result: { action: granted ? "accept" : "decline", content: null } };
  return { result: { decision: granted ? "accept" : "decline" } };
}

const GRANTED = new Set(["ok", "committed", "reconciled"]);
const STOPS = new Set(["park", "expired", "cancelled"]);

function toolText(status, result) {
  if (status === "park") return "Paused: this action needs an approval. The run is parked; end your turn now.";
  if (status === "deduplicated" || status === "reconciled" || GRANTED.has(status)) return JSON.stringify({ status, result: result.result ?? null, ref: result.ref ?? null });
  return JSON.stringify({ status, error: result.error || status });
}

async function runTurn(ctx, session, text, stopRef) {
  const handlers = {
    signal: ctx.signal,
    onEvent: (event) => ctx.emit(event.type === "message" ? "progress" : "native_tool", event),
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
      if (call.kind === "dynamic") {
        const success = GRANTED.has(result.status) || result.status === "deduplicated";
        return { result: { success, contentItems: [{ type: "inputText", text: toolText(result.status, result) }] } };
      }
      // A codex.* approval is single use: the same gated call is not granted twice.
      return nativeResponse(call.kind, GRANTED.has(result.status), request.params);
    },
  };
  const turn = await session.runTurn({ inputId: `${ctx.runId}:a${ctx.attempt}:${stopRef.turns++}`, text }, handlers);
  if (stopRef.stop?.crash) throw stopRef.stop.crash;
  return turn;
}

export const codexJobAdapter = Object.freeze({
  id: "codex",
  jobExecutor: "codex-app-server",
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
    const workspace = await prepareAgentJobWorkspace({ home: ctx.home, baseDir: ctx.baseDir, job: ctx.job, runId: ctx.runId, inputs: input.inputs });
    ctx.emit("workspace", { path: workspace.path, kind: workspace.kind });
    const previous = ctx.checkpoints(["codex_session"]).at(-1)?.data || null;
    const session = new CodexJobSession({ env: ctx.env });
    const stopRef = { stop: null, turns: 0 };
    try {
      const opened = await session.open({
        sessionRef: previous?.sessionRef || "",
        cwd: workspace.path,
        model: input.model || "",
        developerInstructions: developerInstructions(ctx, workspace),
        dynamicTools: dynamicToolSpecs(exposedTools(ctx)),
      });
      ctx.emit("codex_session", { sessionRef: opened.sessionRef, resumed: opened.resumed });
      ctx.fault("codex_session_started");
      let text = opened.resumed ? resumePrompt(input, ctx.previousAttempt || { attempt: "?", reason: "interrupted" }) : firstPrompt(input);
      for (let repairs = 0; ; repairs += 1) {
        const turn = await runTurn(ctx, session, text, stopRef);
        if (stopRef.stop) return { type: stopRef.stop.type, approval: stopRef.stop.approval };
        if (turn.status === "cancelled") {
          if (ctx.signal?.reason === "timeout") throw Object.assign(new Error("attempt_timeout"), { kind: "timeout", retryable: true });
          return { type: "cancelled" };
        }
        if (turn.status === "failed") throw Object.assign(new Error(turn.error?.message || "codex_turn_failed"), codexJobErrorFields(turn.error?.message));
        const output = parseCodexFinalOutput(turn.finalText);
        const invalid = input.outputSchema ? validateOutput(input.outputSchema, output) : null;
        if (!invalid || repairs >= 1) return { output };
        ctx.emit("output_repair", { error: String(invalid).slice(0, 500) });
        text = `Your final answer did not match the output schema (${invalid}). Reply with only the corrected JSON value.`;
      }
    } catch (error) {
      if (error?.kind || error?.injectedCrash || error?.leaseLost) throw error;
      // Failures outside a turn (spawn, transport, RPC) are provider errors.
      const fields = codexJobErrorFields(error?.message || error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: "provider", retryable: fields.class === "transient" });
    } finally {
      session.close();
    }
  },
});
