// Fake `codex app-server` for the conformance suite. Derived from the inline
// fake in test/codex-app-server.test.js, trimmed to the JSON-RPC methods the
// Orkestr Codex adapter uses for a turn lifecycle, plus scenario markers:
//   [scenario:progress]        commentary item before the final answer
//   [scenario:slow]            turn stays active until turn/interrupt
//   [scenario:tool]            command approval request before the answer
//   [scenario:fault:<class>]   turn fails with an auth/transient/permanent error
//   FAKE_CODEX_JOB_SCRIPT      (env, JSON array; prompts without a marker) a
//                              scripted Agent Job: {say}, {tool, args} via
//                              item/tool/call, {command} via a command approval,
//                              {fileChange: [{path, kind}]} via a file change
//                              approval (item/started, then item/completed),
//                              {wait} (stay active), {final}. Each thread keeps
//                              its script position, so a resumed thread continues
//                              after the last answered step.
// State persists in FAKE_CODEX_STATE so a respawned process (restart) sees the
// same threads, but marks them notLoaded like a real app-server would.
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CODEX_STATE;
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { threads: [], calls: [], spawnCount: 0 }; }
}
function writeState(state) {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}
if (args[0] === "--version") { console.log("codex-cli fake"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using API key"); process.exit(0); }
if (args[0] !== "app-server") process.exit(0);
if (args.includes("--help")) { console.log("Usage: codex app-server [OPTIONS]"); process.exit(0); }

const boot = readState();
boot.spawnCount = (boot.spawnCount || 0) + 1;
for (const thread of boot.threads || []) { thread.loaded = false; thread.activeTurnId = ""; }
writeState(boot);

const FAULTS = {
  auth: "unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake-conformance",
  transient: "stream disconnected before completion: 429 Too Many Requests (rate limit reached, retry later)",
  permanent: "invalid_request_error: the request body is malformed",
};
// Provider latency between lifecycle notifications. Low values (<~100ms) exercise
// the post-turn/start runtime write race documented in docs/spec/conformance.md.
const STEP_MS = Number(process.env.FAKE_CODEX_STEP_MS || 50);
const nextServerRequestId = { value: 9000 };
const pendingApprovals = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const jobScript = process.env.FAKE_CODEX_JOB_SCRIPT ? JSON.parse(process.env.FAKE_CODEX_JOB_SCRIPT) : null;
const scenarioOf = (text) => /\[scenario:([a-z:]+)\]/.exec(text)?.[1] || (jobScript ? "script" : "echo");
const pendingToolCalls = new Map();

function completeTurn(state, thread, turn, status, extra = {}) {
  turn.status = status;
  thread.status = { type: "idle" };
  thread.activeTurnId = "";
  writeState(state);
  send({ method: "turn/completed", params: { turn: { ...turn, status, error: extra.error || null } } });
}

function agentItem(turn, text, phase) {
  const item = { type: "agentMessage", id: `agent_${phase}_${turn.id}`, text, phase };
  turn.items.push(item);
  send({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.id, item } });
}

function startTurn(id, params) {
  const state = readState();
  const thread = state.threads.find((item) => item.id === params.threadId);
  if (!thread || !thread.loaded) return send({ id, error: { code: -32000, message: `thread not found: ${params.threadId}` } });
  state.nextTurnNumber = (state.nextTurnNumber || 0) + 1;
  state.turnStarts = (state.turnStarts || 0) + 1;
  const text = params.input?.find((item) => item.type === "text")?.text || "";
  const scenario = scenarioOf(text);
  const turn = { id: `turn_${String(state.nextTurnNumber).padStart(6, "0")}`, threadId: thread.id, status: "inProgress", items: [] };
  turn.items.push({ type: "userMessage", id: `user_${turn.id}`, content: [{ type: "text", text }] });
  thread.turns.push(turn);
  thread.status = { type: "active", activeFlags: [] };
  thread.activeTurnId = turn.id;
  writeState(state);
  send({ id, result: { turn } });
  send({ method: "turn/started", params: { turn } });
  // Later lifecycle notifications arrive asynchronously, like a real provider.
  setTimeout(() => continueTurn(thread.id, turn.id, scenario, text), STEP_MS);
}

function continueTurn(threadId, turnId, scenario, text) {
  const state = readState();
  const thread = state.threads.find((item) => item.id === threadId);
  const turn = thread?.turns.find((item) => item.id === turnId);
  if (!turn || turn.status !== "inProgress") return;
  if (scenario.startsWith("fault:")) {
    const message = FAULTS[scenario.slice("fault:".length)] || "unknown failure";
    return completeTurn(state, thread, turn, "failed", { error: { message } });
  }
  if (scenario === "slow") return undefined;
  if (scenario === "script") return continueScript(state, thread, turn);
  if (scenario === "tool") {
    const requestId = nextServerRequestId.value++;
    pendingApprovals.set(String(requestId), { threadId, turnId, text });
    return send({ id: requestId, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: `call_${turnId}`, command: ["echo", "conformance"], cwd: thread.cwd } });
  }
  if (scenario === "progress") {
    agentItem(turn, "Inspecting the workspace before answering.", "commentary");
    writeState(state);
    return setTimeout(() => continueTurn(threadId, turnId, "echo", text), STEP_MS);
  }
  agentItem(turn, `Reply to: ${text}`, "final_answer");
  return completeTurn(state, thread, turn, "completed");
}

// Scripted Agent Job turn: run steps from the thread's position until a step
// waits for an answer from Orkestr (tool call, approval) or the turn ends.
function continueScript(state, thread, turn) {
  const step = jobScript[thread.scriptStep || 0];
  if (!step) {
    agentItem(turn, "Nothing left to do.", "final_answer");
    return completeTurn(state, thread, turn, "completed");
  }
  if (step.wait) return undefined;
  if (step.say !== undefined || step.final !== undefined) {
    const final = step.final !== undefined;
    agentItem(turn, final ? (typeof step.final === "string" ? step.final : JSON.stringify(step.final)) : step.say, final ? "final_answer" : "commentary");
    thread.scriptStep = (thread.scriptStep || 0) + 1;
    if (final) return completeTurn(state, thread, turn, "completed");
    writeState(state);
    return setTimeout(() => continueTurn(thread.id, turn.id, "script", ""), STEP_MS);
  }
  const requestId = nextServerRequestId.value++;
  pendingToolCalls.set(String(requestId), { threadId: thread.id, turnId: turn.id, step });
  if (step.command) {
    return send({ id: requestId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, itemId: `cmd_${requestId}`, command: step.command, cwd: thread.cwd } });
  }
  if (step.fileChange) {
    const item = { type: "fileChange", id: `fc_${requestId}`, status: "inProgress", changes: step.fileChange.map((change) => ({ path: change.path, kind: { type: change.kind || "add" }, diff: "" })) };
    send({ method: "item/started", params: { threadId: thread.id, turnId: turn.id, item } });
    return send({ id: requestId, method: "item/fileChange/requestApproval", params: { threadId: thread.id, turnId: turn.id, itemId: item.id } });
  }
  const tool = String(step.tool).replace(/\./g, "__");
  if (!step.force && !(thread.dynamicTools || []).includes(tool)) {
    // A model cannot call a tool it was not given.
    (state.toolCalls ||= []).push({ tool: step.tool, exposed: false });
    thread.scriptStep = (thread.scriptStep || 0) + 1;
    writeState(state);
    return setTimeout(() => continueTurn(thread.id, turn.id, "script", ""), STEP_MS);
  }
  return send({ id: requestId, method: "item/tool/call", params: { threadId: thread.id, turnId: turn.id, callId: `call_${requestId}`, tool, arguments: step.args || {} } });
}

function answerToolCall(message, pending) {
  pendingToolCalls.delete(String(message.id));
  const state = readState();
  const thread = state.threads.find((item) => item.id === pending.threadId);
  const turn = thread?.turns.find((item) => item.id === pending.turnId);
  // An answer for an interrupted turn is ignored: the step is retried later.
  if (!turn || turn.status !== "inProgress") return;
  if (pending.step.command) (state.commandDecisions ||= []).push({ command: pending.step.command, decision: message.result?.decision || "error" });
  else if (pending.step.fileChange) {
    const decision = message.result?.decision || "error";
    (state.fileChanges ||= []).push({ paths: pending.step.fileChange.map((change) => change.path), decision });
    const item = { type: "fileChange", id: `fc_${message.id}`, status: decision === "accept" ? "completed" : "declined", changes: [] };
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
  }
  else (state.toolCalls ||= []).push({ tool: pending.step.tool, exposed: true, success: message.result?.success === true, text: message.result?.contentItems?.[0]?.text || message.error?.message || "" });
  thread.scriptStep = (thread.scriptStep || 0) + 1;
  writeState(state);
  setTimeout(() => continueTurn(thread.id, turn.id, "script", ""), STEP_MS);
}

function answerApproval(message) {
  const call = pendingToolCalls.get(String(message.id));
  if (call) return answerToolCall(message, call);
  const pending = pendingApprovals.get(String(message.id));
  if (!pending) return;
  pendingApprovals.delete(String(message.id));
  const state = readState();
  const decision = message.result?.decision || "decline";
  state.toolDecisions ||= [];
  state.toolDecisions.push({ turnId: pending.turnId, decision, executed: decision === "accept" });
  const thread = state.threads.find((item) => item.id === pending.threadId);
  const turn = thread?.turns.find((item) => item.id === pending.turnId);
  if (!turn) return writeState(state);
  agentItem(turn, `Reply to: ${pending.text} (tool ${decision === "accept" ? "executed" : "denied"})`, "final_answer");
  completeTurn(state, thread, turn, "completed");
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method && message.id !== undefined) return answerApproval(message);
  const { id } = message;
  const params = message.params || {};
  const state = readState();
  state.calls ||= [];
  state.calls.push({ method: message.method || "", threadId: params.threadId || "" });
  writeState(state);
  switch (message.method) {
    case "initialize": return send({ id, result: { userAgent: "fake", platformFamily: "linux", platformOs: "linux" } });
    case "initialized": return undefined;
    case "thread/start": {
      const thread = { id: `thr_${String(state.threads.length + 1).padStart(3, "0")}`, sessionId: "sess_001", name: "", preview: "", cwd: params.cwd || "", status: { type: "idle" }, loaded: true, turns: [], dynamicTools: (params.dynamicTools || []).map((tool) => tool.name), startParams: { approvalPolicy: params.approvalPolicy, sandbox: params.sandbox } };
      state.threads.push(thread);
      writeState(state);
      send({ id, result: { thread } });
      return send({ method: "thread/started", params: { thread } });
    }
    case "thread/resume": {
      const thread = state.threads.find((item) => item.id === params.threadId);
      if (!thread) return send({ id, error: { code: -32000, message: `thread not found: ${params.threadId}` } });
      thread.loaded = true;
      thread.status = { type: "idle" };
      writeState(state);
      return send({ id, result: { thread } });
    }
    case "thread/read": return send({ id, result: { thread: state.threads.find((item) => item.id === params.threadId) || { id: params.threadId, turns: [] } } });
    case "thread/list": return send({ id, result: { data: state.threads.map(({ turns, loaded, ...thread }) => ({ ...thread, status: loaded ? thread.status : { type: "notLoaded" } })), nextCursor: null } });
    case "model/list": return send({ id, result: { data: [], nextCursor: null } });
    case "turn/start": return startTurn(id, params);
    case "turn/interrupt": {
      const thread = state.threads.find((item) => item.id === params.threadId);
      const turn = thread?.turns.find((item) => item.id === params.turnId);
      send({ id, result: {} });
      if (thread && turn && turn.status === "inProgress") {
        completeTurn(state, thread, turn, "interrupted", { error: { message: "Conversation interrupted - tell the model what to do differently." } });
      }
      return undefined;
    }
    default: return send({ id, result: {} });
  }
});
