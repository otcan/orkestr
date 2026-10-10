import { listEvents } from "../../storage/src/store.js";
import { appendEvent } from "../../storage/src/store.js";
import { listEffects } from "./effect-ledger.js";
import { listExecutions, recoverInterruptedExecutions, runNextThreadMessage } from "./executors.js";
import { listSimulatedPullRequests } from "./simulated-pr-sink.js";
import { appendThreadMessage, createThread, listThreadMessages, updateThread, updateThreadMessage } from "./threads.js";

// The "repository maintainer" demo job: a durable Agent Job run by the
// simulated provider. Each call to runDemoJobAttempt() is one process lifetime;
// a crash kills the process and the next call recovers and resumes the job.

export const demoJob = Object.freeze({
  id: "repository-maintainer-demo",
  trigger: { type: "api_event", eventId: "evt-demo-0001" },
  agent: { provider: "simulated", fallback: [] },
  task: "Find an outdated dependency in example/repo, open a pull request with the fix, and merge it once approved.",
  permissions: { approvalRequired: ["merge_pull_request"] },
  runtime: { durable: true, maxAttempts: 3 },
});

const interruptedError = "interrupted_by_orkestr_restart";

async function ensureDemoThread({ crash = true, approvalTimeoutMs = 600_000 } = {}, env) {
  return createThread({
    id: demoJob.id,
    name: demoJob.id,
    executor: {
      id: demoJob.agent.provider,
      metadata: {
        simulated: {
          jobId: demoJob.id,
          repository: "example/repo",
          approvalRequired: demoJob.permissions.approvalRequired,
          crashAt: crash ? "after_side_effect" : "",
          crashMode: "exit",
          approvalTimeoutMs,
        },
      },
    },
  }, env);
}

async function ensureTriggerMessage(thread, env) {
  const messages = await listThreadMessages(thread.id, env);
  const existing = messages.find((message) => message.role === "user" && message.sourceEventId === demoJob.trigger.eventId);
  if (existing) return existing;
  const message = await appendThreadMessage(thread.id, {
    role: "user",
    source: `trigger:${demoJob.trigger.type}`,
    text: demoJob.task,
    sourceEventId: demoJob.trigger.eventId,
    clientMessageId: demoJob.trigger.eventId,
    state: "queued",
  }, env);
  await updateThread(thread.id, { state: "queued" }, env);
  await appendEvent({ type: "agent_job_triggered", jobId: demoJob.id, trigger: demoJob.trigger, messageId: message.id }, env);
  return message;
}

async function resumeInterruptedMessage(thread, message, env) {
  const executions = (await listExecutions(env)).filter((execution) => execution.messageId === message.id);
  if (message.state !== "failed" || message.error !== interruptedError) return { resumed: false, attempts: executions.length };
  if (executions.length >= demoJob.runtime.maxAttempts) {
    await appendEvent({ type: "agent_job_attempts_exhausted", jobId: demoJob.id, attempts: executions.length }, env);
    throw Object.assign(new Error("agent_job_max_attempts_exceeded"), { code: "agent_job_max_attempts_exceeded" });
  }
  await updateThreadMessage(thread.id, message.id, { state: "queued", error: "" }, env);
  await updateThread(thread.id, { state: "queued", lastError: "" }, env);
  await appendEvent({ type: "agent_job_resumed", jobId: demoJob.id, messageId: message.id, previousAttempts: executions.length }, env);
  return { resumed: true, attempts: executions.length };
}

export async function runDemoJobAttempt(options = {}, env = process.env) {
  const recovered = await recoverInterruptedExecutions(env);
  const thread = await ensureDemoThread(options, env);
  const trigger = await ensureTriggerMessage(thread, env);
  const current = (await listThreadMessages(thread.id, env)).find((message) => message.id === trigger.id) || trigger;
  if (current.state === "completed") return { state: "completed", alreadyCompleted: true, recovered: recovered.length };
  const resume = await resumeInterruptedMessage(thread, current, env);
  const execution = await runNextThreadMessage(thread.id, {}, env);
  return { state: execution.state, executionId: execution.id, recovered: recovered.length, resumed: resume.resumed, result: execution.result };
}

export async function demoJobReport(env = process.env) {
  const [effects, pullRequests, executions, events] = await Promise.all([
    listEffects({ jobId: demoJob.id }, env),
    listSimulatedPullRequests(env),
    listExecutions(env),
    listEvents(env, 500),
  ]);
  const messages = await listThreadMessages(demoJob.id, env).catch(() => []);
  const openEffect = effects.find((effect) => effect.kind === "pull_request.open");
  const mergeEffect = effects.find((effect) => effect.kind === "pull_request.merge");
  const crashes = events.filter((event) => event.type === "simulated_provider_crash");
  const jobPullRequests = pullRequests.filter((pullRequest) => pullRequest.idempotencyKey === openEffect?.key);
  const checks = [
    ["crash_injected", crashes.length >= 1],
    ["single_pull_request", jobPullRequests.length === 1],
    ["open_effect_reconciled_after_crash", openEffect?.state === "committed" && openEffect?.reconciled === true],
    ["merge_approved_before_effect", mergeEffect?.approval?.decision === "approved"],
    ["merged_exactly_once", jobPullRequests[0]?.state === "merged" && jobPullRequests[0]?.merges === 1],
    ["final_execution_completed", executions.some((execution) => execution.threadId === demoJob.id && execution.state === "completed")],
    ["final_answer_recorded", messages.some((message) => message.role === "assistant" && message.source === "executor:simulated")],
  ].map(([name, ok]) => ({ name, ok: Boolean(ok) }));
  const auditTypes = /^(agent_job_|executor_|effect_|simulated_provider_)/;
  return {
    ok: checks.every((check) => check.ok),
    checks,
    effects,
    pullRequests: jobPullRequests,
    executions: executions.filter((execution) => execution.threadId === demoJob.id),
    audit: events.filter((event) => auditTypes.test(String(event.type || ""))),
  };
}
