import fs from "node:fs/promises";
import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread, updateThreadMessage } from "./threads.js";

// One-time delivery of an executor-switch handoff. The switch stores
// thread.pendingExecutorHandoff; the first turn the new executor starts claims
// it, persists the preamble on that input message (so retries and input
// identity digests see the same payload), and clears the pending marker.

function clean(value = "") {
  return String(value || "").trim();
}

function maxPreambleChars(env = process.env) {
  const parsed = Number(env.ORKESTR_EXECUTOR_HANDOFF_MAX_CHARS || 60000);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : 60000;
}

export function executorHandoffPreambleText(handoff = {}, content = "", env = process.env) {
  const max = maxPreambleChars(env);
  const body = content.length > max ? `${content.slice(0, max)}\n[handoff truncated; full file: ${handoff.path}]` : content;
  return [
    `[Orkestr executor handoff, delivered once. Full file: ${clean(handoff.path) || "(unavailable)"}]`,
    body || clean(handoff.intro),
    "[End of executor handoff. The user's message follows.]",
  ].filter(Boolean).join("\n\n");
}

export async function claimExecutorHandoffForMessage(threadOrId, message, executor, env = process.env) {
  if (!message?.id || clean(message.executorHandoffPreamble)) return message;
  const threadId = clean(typeof threadOrId === "string" ? threadOrId : threadOrId?.id);
  const thread = threadId ? await getThread(threadId, env).catch(() => null) : null;
  const handoff = thread?.pendingExecutorHandoff;
  if (!handoff || clean(handoff.to) !== clean(executor)) return message;
  const content = await fs.readFile(clean(handoff.path), "utf8").catch(() => "");
  const preamble = executorHandoffPreambleText(handoff, content, env);
  const updated = await updateThreadMessage(thread.id, message.id, {
    executorHandoffPreamble: preamble,
    executorHandoffPath: clean(handoff.path) || null,
  }, env).catch(() => null);
  if (!updated) return message;
  await updateThread(thread.id, {
    lastExecutorHandoff: { ...handoff, deliveredAt: new Date().toISOString(), messageId: message.id },
  }, env, { unset: ["pendingExecutorHandoff"] });
  await appendEvent({
    type: "thread_executor_handoff_delivered",
    threadId: thread.id,
    messageId: message.id,
    executor: clean(executor),
    path: clean(handoff.path) || null,
  }, env).catch(() => {});
  return updated;
}
