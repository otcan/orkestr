// `orkestr attach` for a chat Orkestr V2 serves.
//
// V1 delegates such a chat (its WhatsApp binding names a remote runtime) and
// never runs it, so its old V1 terminal is not the chat's agent: input typed
// there starts no V2 run, carries no owner proof and its answer reaches no
// one. Attach instead opens a terminal chat with the conversation's current
// V2 agent: each line is an owner-authored message, admitted the way the V2
// web composer admits it, and the conversation's run updates stream back.
// The V2 adapter mirrors such owner messages and their answers to the bound
// WhatsApp group, exactly as for a message typed in the V2 web app.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { remoteWhatsAppRuntimeBinding } from "../../../packages/core/src/thread-remote-runtime-binding.js";
import { createV2OwnerSession, readOwnerLogin, readPrivateJson, v2AttachConfig, v2AttachError } from "./v2-owner-session.js";
import { describeNativeTarget, formatNativeLine } from "./v2-native-target.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const newestSequence = Number.MAX_SAFE_INTEGER;
const updatesPage = 100;
const settleWaitMs = 3000;
const admitDeadlineMs = 10 * 60_000;
const windowConflictsMax = 3;
const transientMax = 6;

function clean(value) {
  return String(value ?? "").trim();
}

function isUuid(value) {
  return uuidPattern.test(clean(value));
}

// The V1 test for "V2 runs this chat": the same one V1 uses to never run it.
export function v2DelegationOf(thread, env = process.env) {
  return thread && typeof thread === "object" ? remoteWhatsAppRuntimeBinding(thread, env) : null;
}

// V1 thread -> adapter route -> V2 conversation. The binding file is the one
// the adapter itself serves the chat from; it must name both ids exactly.
export function resolveV2Target({ thread = null, conversationId = "", env = process.env, readFile = fs.readFileSync } = {}) {
  const config = v2AttachConfig(env, readFile);
  if (conversationId) {
    if (!isUuid(conversationId)) throw v2AttachError("v2_attach_conversation_invalid", "--conversation needs a V2 conversation UUID");
    return { config, conversationId: clean(conversationId).toLowerCase(), threadId: "", name: "", remoteThreadId: "" };
  }
  const remote = v2DelegationOf(thread, env);
  if (!remote) return null;
  const remoteThreadId = clean(remote.remoteThreadId);
  if (!isUuid(remoteThreadId)) throw v2AttachError("v2_attach_binding_invalid", `thread ${thread.id} is delegated to a remote runtime, but its route id is not a UUID`);
  if (!config.bindingsDir) throw v2AttachError("v2_attach_config_invalid", `${config.configPath} names no bindings_dir`);
  const file = path.join(config.bindingsDir, `${remoteThreadId}.json`);
  const binding = readPrivateJson(file, "V2 adapter binding", readFile);
  if (binding.remote_thread_id !== remoteThreadId || binding.public_thread_id !== thread.id || !isUuid(binding.conversation_id)) {
    throw v2AttachError("v2_attach_binding_mismatch", `${file} does not bind thread ${thread.id}`);
  }
  if (binding.revoked === true || binding.enabled === false) {
    throw v2AttachError("v2_attach_binding_revoked", `the V2 binding of thread ${thread.id} is revoked or disabled; it is not attachable`);
  }
  return {
    config,
    conversationId: binding.conversation_id.toLowerCase(),
    threadId: thread.id,
    name: clean(thread.bindingName || thread.name || thread.title),
    remoteThreadId,
  };
}

function conversationPath(target, suffix = "") {
  return `/api/v2/conversations/${target.conversationId}${suffix}`;
}

// The chat's current agent (settings) and work phase. Read-only.
export async function describeV2Agent(session, target) {
  const settings = await session.call("GET", conversationPath(target, "/settings"));
  if (settings.status === 404) throw v2AttachError("v2_attach_conversation_not_found", `V2 has no conversation ${target.conversationId}`);
  if (settings.status !== 200 || settings.json?.conversation_id !== target.conversationId) {
    throw v2AttachError("v2_attach_settings_unavailable", `V2 settings answered HTTP ${settings.status}`);
  }
  const execution = await session.call("GET", conversationPath(target, "/execution")).catch(() => null);
  const status = execution?.status === 200 ? execution.json || {} : {};
  return {
    provider: clean(settings.json.provider),
    model: clean(settings.json.model),
    reasoningEffort: clean(settings.json.reasoning_effort),
    phase: clean(status.phase) || "idle",
    resolvedModel: clean(status.models?.actual_model || status.models?.resolved_model),
  };
}

export function v2TargetSummary(target, agent = null) {
  return {
    attachKind: "v2-owner-chat",
    threadId: target.threadId || null,
    name: target.name || null,
    conversationId: target.conversationId,
    remoteThreadId: target.remoteThreadId || null,
    provider: agent?.provider || null,
    model: agent?.model || null,
    reasoningEffort: agent?.reasoningEffort || null,
    phase: agent?.phase || null,
    web: `${target.config.origin}/#conversation/${target.conversationId}`,
  };
}

export function formatV2TargetLine(summary) {
  const fields = [
    `v2-chat conversation=${summary.conversationId}`,
    summary.threadId ? `thread=${summary.threadId}` : "",
    summary.provider ? `provider=${summary.provider}` : "",
    summary.model ? `model=${summary.model}` : "",
    summary.reasoningEffort ? `effort=${summary.reasoningEffort}` : "",
    summary.name ? `name=${JSON.stringify(summary.name)}` : "",
    `web=${summary.web}`,
  ];
  return `${fields.filter(Boolean).join(" ")}\n`;
}

const sleepFor = (ctx) => (ms) => (ctx.sleepImpl ? ctx.sleepImpl(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

// One owner message: save it, then admit it into the conversation's window,
// with the web composer's rules (wait while work settles, a fresh request on
// a 409, the same idempotent request after a transient failure).
export async function sendOwnerMessage(session, target, text, { sleep, notify = () => {}, now = Date.now, cancelled = () => false } = {}) {
  const clientMessageId = `cli-attach-${randomUUID()}`;
  const deadline = now() + admitDeadlineMs;
  let receipt = null;
  for (let attempt = 1; !receipt; attempt += 1) {
    if (cancelled()) return { ok: false, notice: "Left before V2 confirmed the message. Check the chat before sending it again." };
    const saved = await session.call("POST", conversationPath(target, "/messages"), { client_message_id: clientMessageId, text, author: "owner" }).catch(() => null);
    const json = saved?.json || {};
    if ([200, 202].includes(saved?.status) && isUuid(json.message_id) && isUuid(json.event_id) && json.sequence > 0) {
      receipt = json;
    } else if ([400, 403, 404, 409, 413, 422].includes(saved?.status)) {
      return { ok: false, notice: `Not sent: ${json.message || `HTTP ${saved.status}`}` };
    } else if (attempt >= 3) {
      return { ok: false, notice: "Not sent: V2 did not confirm the message. Check the chat before sending again." };
    } else {
      await sleep(1000 * attempt);
    }
  }
  let request = null;
  let conflicts = 0;
  let transient = 0;
  let waiting = false;
  for (;;) {
    if (cancelled()) return { ok: false, messageId: receipt.message_id, notice: "Left before work started; the message is saved in the chat." };
    if (now() > deadline) return { ok: false, messageId: receipt.message_id, notice: "Saved, but work was not confirmed in time. Check the chat." };
    if (!request) {
      const window = await session.call("GET", conversationPath(target, "/window")).catch(() => null);
      const status = window?.status === 200 ? window.json : null;
      if (window?.status !== 204 && !(status && status.conversation_id === target.conversationId && isUuid(status.window_id))) {
        transient += 1;
        if (transient > transientMax) return { ok: false, messageId: receipt.message_id, notice: "Saved. Work status unavailable; check the chat." };
        await sleep(1000 * transient);
        continue;
      }
      if (status && !["active", "closed"].includes(status.state)) {
        if (!waiting) notify("Saved. Waiting for the current work to settle...");
        waiting = true;
        await sleep(settleWaitMs);
        continue;
      }
      request = {
        request_key: randomUUID(),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: clientMessageId,
        expected_generation: status ? status.generation : 0,
        window_id: status?.state === "active" ? status.window_id : null,
        predecessor_window_id: status?.state === "closed" ? status.window_id : null,
      };
    }
    const admitted = await session.call("POST", conversationPath(target, "/window"), request).catch(() => null);
    const json = admitted?.json || {};
    const same = json.request_key === request.request_key && json.input_message_id === request.input_message_id;
    if ([200, 201].includes(admitted?.status) && same && json.status?.conversation_id === target.conversationId) {
      return { ok: true, messageId: receipt.message_id, notice: request.window_id ? "Sent. Added to the running turn." : "Sent. Waiting for a reply." };
    }
    if (admitted?.status === 202 && same && json.conversation_id === target.conversationId && json.state !== "withdrawn") {
      return { ok: true, messageId: receipt.message_id, notice: `Sent. Queued${json.position ? ` (position ${json.position})` : ""}.` };
    }
    if (admitted?.status === 409 && json.code === "restricted_conversation") {
      return { ok: true, messageId: receipt.message_id, notice: "Sent to the restricted thread." };
    }
    if (admitted?.status === 409 || admitted?.status === 202) {
      request = null;
      conflicts += 1;
      if (conflicts >= windowConflictsMax) return { ok: false, messageId: receipt.message_id, notice: "Saved, but work could not start. Finish or stop the current work, then send again." };
      await sleep(1000);
      continue;
    }
    if ([400, 403, 404, 422].includes(admitted?.status)) {
      return { ok: false, messageId: receipt.message_id, notice: `Saved, but work could not start (${json.code || `HTTP ${admitted.status}`}).` };
    }
    transient += 1;
    if (transient > transientMax) return { ok: false, messageId: receipt.message_id, notice: "Saved. Work not confirmed; check the chat." };
    await sleep(1000 * transient);
  }
}

async function readUpdates(session, target, query) {
  const response = await session.call("GET", conversationPath(target, `/updates?${query}`));
  const json = response.json || {};
  if (response.status !== 200 || json.conversation_id !== target.conversationId || !Array.isArray(json.updates)) {
    throw v2AttachError("v2_attach_updates_unavailable", `run updates answered HTTP ${response.status}`);
  }
  return json;
}

async function payloadText(session, target, update) {
  if (update.payload_removed) return "(removed)";
  const response = await session.call("GET", conversationPath(target, `/payloads/${update.payload_id}`));
  if (response.status !== 200) return `(update unavailable: HTTP ${response.status})`;
  return typeof response.json?.text === "string" ? response.json.text : "(removed)";
}

function formatUpdate(update, text, label) {
  const at = Number.isFinite(update.observed_at_ms) ? `${new Date(update.observed_at_ms).toISOString().slice(11, 19)}Z` : "";
  const kind = update.final_answer ? "answer" : "update";
  return `\n-- ${label} ${kind} ${at}\n${String(text).trimEnd()}\n\n`;
}

// Interim updates and accepted answers of the conversation, in event order,
// from `cursor` on. Returns the new cursor.
export async function streamUpdates(session, target, cursor, emit, label) {
  let after = cursor;
  for (let page = 0; page < 5; page += 1) {
    const result = await readUpdates(session, target, `after_sequence=${after}&limit=${updatesPage}`);
    for (const update of result.updates) {
      if (!(update.sequence > after)) continue;
      emit(formatUpdate(update, await payloadText(session, target, update), label), update);
      after = update.sequence;
    }
    if (result.next_after_sequence === null || result.next_after_sequence === undefined) break;
  }
  return after;
}

export async function runV2Chat(target, session, agent, ctx, { readOnly = false, intervalMs = 0, timeoutMs = 0, history = 1 } = {}) {
  const sleep = sleepFor(ctx);
  const stdout = ctx.stdout;
  const label = [agent.provider, agent.model].filter(Boolean).join("/") || "agent";
  const pollMs = Math.max(500, intervalMs || 2000);
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  const summary = v2TargetSummary(target, agent);
  stdout.write([
    `Orkestr V2 chat ${summary.name ? `"${summary.name}" ` : ""}(conversation ${target.conversationId})`,
    `Agent: ${label}${agent.reasoningEffort ? ` (effort ${agent.reasoningEffort})` : ""}, currently ${agent.phase}.`,
    readOnly
      ? "Read-only: watching run updates; nothing you type is sent. Ctrl-C leaves."
      : "Owner chat through V2 (not the native session): each line is an owner message, run by the chat's V2 agent; the WhatsApp group sees it too. /status shows the work phase; /exit or Ctrl-D leaves.",
    `Web: ${summary.web}`,
    "",
  ].join("\n"));
  const newest = await readUpdates(session, target, `before_sequence=${newestSequence}&limit=${Math.min(updatesPage, Math.max(1, history || 1))}`);
  let cursor = newest.updates.reduce((max, update) => Math.max(max, update.sequence), 0);
  let rl = null;
  const emit = (text) => {
    if (rl && rl.terminal) {
      readline.clearLine(stdout, 0);
      readline.cursorTo(stdout, 0);
      stdout.write(text);
      rl.prompt(true);
    } else {
      stdout.write(text);
    }
  };
  if (history > 0) {
    for (const update of newest.updates) stdout.write(formatUpdate(update, await payloadText(session, target, update), `${label} (earlier)`));
  }
  let closed = false;
  let leaving = false;
  let abandoned = false;
  let wake = () => {};
  const stop = () => {
    closed = true;
    wake();
  };
  let pending = Promise.resolve();
  let sending = false;
  let awaiting = false;
  let lastPhase = agent.phase;
  const phaseLine = async (always = false) => {
    const execution = await session.call("GET", conversationPath(target, "/execution")).catch(() => null);
    const phase = execution?.status === 200 ? clean(execution.json?.phase) || "idle" : "unknown";
    if (always || phase !== lastPhase) emit(`... ${label}: ${phase}\n`);
    lastPhase = phase;
  };
  if (!readOnly) {
    rl = readline.createInterface({ input: ctx.stdin, output: stdout, terminal: Boolean(ctx.stdin?.isTTY && stdout?.isTTY), prompt: "you> " });
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      leaving = true;
      if (sending) stdout.write("\nFinishing the message being sent (Ctrl-C again leaves now)...\n");
      pending.finally(stop);
    });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return rl.prompt();
      if (text === "/exit" || text === "/quit") return rl.close();
      pending = pending.then(async () => {
        if (abandoned) return;
        if (text === "/status") return phaseLine(true);
        sending = true;
        const result = await sendOwnerMessage(session, target, text, { sleep, notify: (notice) => emit(`${notice}\n`), cancelled: () => abandoned });
        if (result.ok) awaiting = true;
        emit(`${result.notice}\n`);
      }).catch((error) => emit(`Not sent: ${error?.message || error}\n`)).finally(() => {
        sending = false;
      });
    });
    rl.prompt();
  }
  // Ctrl-C leaves; while a message is still being sent, a second one abandons it.
  const onSigint = () => {
    if (rl && !leaving) return rl.close();
    abandoned = true;
    stop();
  };
  process.on("SIGINT", onSigint);
  try {
    let polls = 0;
    while (!closed) {
      cursor = await streamUpdates(session, target, cursor, (text, update) => {
        emit(text);
        if (update.final_answer) awaiting = false;
      }, label).catch((error) => {
        emit(`(updates unavailable: ${error.code || error.message}; retrying)\n`);
        return cursor;
      });
      polls += 1;
      if (awaiting && polls % 3 === 0) await phaseLine();
      if (deadline && Date.now() >= deadline) break;
      if (closed) break;
      await Promise.race([sleep(pollMs), new Promise((resolve) => { wake = resolve; })]);
    }
    if (!abandoned) await pending;
    if (awaiting) {
      // The answer still arrives in the chat (web app and WhatsApp group).
      stdout.write("Left while the agent is still working; its answer will appear in the chat.\n");
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl?.close();
  }
  return 0;
}

function attachHint(target) {
  return target.threadId || target.conversationId;
}

// Entry point from `orkestr attach`: describe (--print/--json), watch
// (--read-only) or chat as the owner (--chat). Opening the native provider
// session itself is refused until V2 can hold it (see v2-native-target.js).
export async function runV2Attach(target, ctx, { printOnly = false, json = false, readOnly = false, chat = false, intervalMs = 0, timeoutMs = 0, history = 1 } = {}) {
  if (!printOnly && !json && !readOnly && !chat) {
    const native = describeNativeTarget(target, ctx);
    const what = native.available ? `the ${native.provider} session ${native.nativeSessionId}` : "the native session";
    throw v2AttachError("v2_native_attach_unavailable",
      `opening ${what} needs the V2 native-attach hold, which is not deployed yet; for now: orkestr attach ${attachHint(target)} --chat (owner messages through V2) or --read-only`);
  }
  if (chat && !printOnly && !json && !ctx.stdin?.isTTY) {
    throw v2AttachError("v2_attach_tty_required", "sending as the owner needs an interactive terminal; use --read-only to watch or --print to inspect");
  }
  const login = readOwnerLogin(target.config, ctx.readFileImpl || fs.readFileSync);
  const session = createV2OwnerSession(target.config, login, { request: ctx.v2RequestImpl });
  try {
    const agent = await describeV2Agent(session, target);
    if (json || printOnly) {
      const health = await session.call("GET", "/api/v2/health").catch(() => null);
      const native = describeNativeTarget(target, ctx, health?.json?.build?.source_commit || "");
      if (json) {
        ctx.stdout.write(`${JSON.stringify({ ok: true, ...v2TargetSummary(target, agent), native }, null, 2)}\n`);
      } else {
        ctx.stdout.write(formatV2TargetLine(v2TargetSummary(target, agent)));
        ctx.stdout.write(formatNativeLine(native));
      }
      return 0;
    }
    return await runV2Chat(target, session, agent, ctx, { readOnly, intervalMs, timeoutMs, history });
  } finally {
    await session.close();
  }
}
