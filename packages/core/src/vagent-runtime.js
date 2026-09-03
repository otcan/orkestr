import { createHash } from "node:crypto";

const defaultTimeoutMs = 45_000;
const pollIntervalMs = 250;
const maxTimeoutMs = 5 * 60_000;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = message;
  return error;
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function configuredTimeoutMs(env) {
  const configured = Number(env.ORKESTR_VAGENT_TIMEOUT_MS || defaultTimeoutMs);
  if (!Number.isFinite(configured)) return defaultTimeoutMs;
  return Math.min(maxTimeoutMs, Math.max(1_000, Math.floor(configured)));
}

function sessionHash(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function vagentError(error) {
  const raw = String(error?.code || error?.message || "vagent_request_failed").trim();
  return raw.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120) || "vagent_request_failed";
}

function isCompletedFinalFor(message, parentMessageId) {
  return String(message?.role || "").toLowerCase() === "assistant" &&
    String(message?.state || "").toLowerCase() === "completed" &&
    String(message?.phase || "").toLowerCase() === "final_answer" &&
    String(message?.parentMessageId || "") === parentMessageId;
}

export function vagentSpeech(text) {
  const speech = String(text || "")
    .replace(/```[\s\S]*?```/g, " Code is shown in the text response. ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  return speech || "The response is available on screen.";
}

export async function waitForVagentFinal(threadId, parentMessageId, timeoutMs, dependencies, env = process.env) {
  const deadline = dependencies.now() + timeoutMs;
  for (;;) {
    const messages = await dependencies.listThreadMessages(threadId, env);
    const final = messages.find((message) => isCompletedFinalFor(message, parentMessageId));
    if (final) return final;
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) return null;
    await dependencies.sleep(Math.min(pollIntervalMs, remaining));
  }
}

export async function processVagentRequest(request, { env = process.env, dependencies } = {}) {
  if (!dependencies) throw new Error("vagent_dependencies_required");
  if (!envFlag(env.ORKESTR_VAGENT_ENABLED)) throw httpError("vagent_integration_disabled", 404);
  const configuredThreadId = String(env.ORKESTR_VAGENT_THREAD_ID || "").trim();
  if (!configuredThreadId) throw httpError("vagent_thread_unconfigured", 503);

  const startedAt = dependencies.now();
  const sessionIdHash = sessionHash(request.sessionId);
  let threadId = "";
  let inputMessageId = "";
  try {
    const configuredThread = await dependencies.getThread(configuredThreadId, env);
    if (!configuredThread || String(configuredThread.id || "") !== configuredThreadId) {
      throw httpError("vagent_thread_not_found", 404);
    }
    threadId = String(configuredThread.id || "");
    await dependencies.appendEvent({ type: "vagent_request_received", threadId, sessionIdHash }, env);

    let thread;
    try {
      thread = await dependencies.getThreadForPrincipal(configuredThread.id, request.principal, env);
    } catch {
      throw httpError("vagent_thread_forbidden", 403);
    }
    if (!thread) throw httpError("vagent_thread_forbidden", 403);

    const input = await dependencies.enqueueThreadInputForPrincipal(thread.id, {
      source: "vagent",
      text: request.prompt,
      externalId: request.sessionId,
      attachments: [],
      // Speech recognition must not turn a misheard slash command into a
      // privileged runtime action. The text is still sent to the agent.
      commandProcessing: "disabled",
    }, request.principal, env);
    inputMessageId = String(input.id || "");
    await dependencies.appendEvent({ type: "vagent_input_enqueued", threadId: thread.id, sessionIdHash, inputMessageId }, env);

    if (dependencies.threadUsesApiAgent(thread, env)) {
      await dependencies.processApiAgentThreadInput(thread.id, env);
    } else {
      dependencies.requestThreadInputDelivery(thread.id, env);
    }

    const final = await waitForVagentFinal(thread.id, inputMessageId, configuredTimeoutMs(env), dependencies, env);
    if (!final) {
      await dependencies.appendEvent({
        type: "vagent_timeout",
        threadId: thread.id,
        sessionIdHash,
        inputMessageId,
        durationMs: dependencies.now() - startedAt,
      }, env);
      return {
        response: {
          text: "The task is still running in Orkestr. It will continue in the thread.",
          speech: "The task is still running. It will continue in Orkestr.",
        },
      };
    }

    const text = String(final.text || "");
    await dependencies.appendEvent({
      type: "vagent_final_received",
      threadId: thread.id,
      sessionIdHash,
      inputMessageId,
      finalMessageId: String(final.id || ""),
      durationMs: dependencies.now() - startedAt,
    }, env);
    return { response: { text, speech: vagentSpeech(text) } };
  } catch (error) {
    await dependencies.appendEvent({
      type: "vagent_request_failed",
      threadId,
      sessionIdHash,
      inputMessageId,
      durationMs: dependencies.now() - startedAt,
      error: vagentError(error),
    }, env).catch(() => {});
    throw error;
  }
}
