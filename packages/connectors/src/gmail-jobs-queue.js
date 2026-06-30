import { appendEvent } from "../../storage/src/store.js";
import {
  processJobCandidateMessages,
  readJobsQueueSettings,
  updateJobsQueueSettings,
} from "../../core/src/jobs-queue.js";
import { isAdminPrincipal, policyError } from "../../core/src/policy.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { getGmailMessage, listGmailMessages } from "./gmail.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const defaultPollIntervalMs = 10 * minuteMs;
const defaultDigestIntervalMs = 2 * hourMs;
const defaultMaxItemsPerRun = 5;
const defaultQuery = [
  "newer_than:2d",
  "(job OR jobs OR role OR hiring OR recruiter OR opportunity OR LinkedIn OR StepStone OR Wellfound OR 9am)",
].join(" ");

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(lower(value)) || value === true || value === 1;
}

function intValue(value, fallback, min, max) {
  const parsed = Number(value);
  const numeric = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function parseIntervalMs(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  const text = lower(value);
  if (!text) return fallbackMs;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);
  if (!match) return fallbackMs;
  const amount = Math.max(1, Number(match[1]));
  if (match[2] === "ms") return amount;
  if (["s", "sec", "secs"].includes(match[2])) return amount * 1000;
  if (["m", "min", "mins"].includes(match[2])) return amount * minuteMs;
  if (["h", "hr", "hrs"].includes(match[2])) return amount * hourMs;
  return amount * 24 * hourMs;
}

function ownerUserIdFor(input = {}, principal = null, env = process.env) {
  if (principal && !isAdminPrincipal(principal)) return normalizeUserId(principal.userId);
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function jobsQuery(input = {}, env = process.env) {
  return clean(input.query || env.ORKESTR_JOBS_GMAIL_QUERY) || defaultQuery;
}

function jobsTargetThreadId(input = {}, env = process.env) {
  return clean(input.targetThreadId || input.threadId || env.ORKESTR_JOBS_TARGET_THREAD_ID || env.ORKESTR_JOBS_THREAD_ID);
}

function jobsAutomationEnabled(env = process.env) {
  return truthy(env.ORKESTR_JOBS_AUTOMATION_ENABLED, false);
}

function gmailScopeOptions(principal = null, ownerUserId = "") {
  return principal && !isAdminPrincipal(principal)
    ? { principal, userId: ownerUserId }
    : { principal };
}

export async function collectGmailJobMessages(input = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const ownerUserId = ownerUserIdFor(input, options.principal || null, env);
  const maxResults = intValue(input.maxResults ?? input.maxItemsPerRun ?? env.ORKESTR_JOBS_MAX_ITEMS_PER_RUN, defaultMaxItemsPerRun, 1, 20);
  const query = jobsQuery(input, env);
  const gmailOptions = gmailScopeOptions(options.principal || null, ownerUserId);
  const listed = await listGmailMessages({ maxResults, query }, env, fetchImpl, gmailOptions);
  const messages = [];
  for (const message of listed.messages || []) {
    messages.push(await getGmailMessage(message.id, env, fetchImpl, gmailOptions));
  }
  return {
    ownerUserId,
    query,
    maxResults,
    resultSizeEstimate: listed.resultSizeEstimate || 0,
    nextPageToken: listed.nextPageToken || "",
    messages,
  };
}

export async function runGmailJobsPoll(input = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const collected = await collectGmailJobMessages(input, env, fetchImpl, options);
  const shouldPresent = input.present === undefined ? truthy(env.ORKESTR_JOBS_POST_NEW, true) : input.present !== false;
  const result = await processJobCandidateMessages({
    ...input,
    ownerUserId: collected.ownerUserId,
    targetThreadId: jobsTargetThreadId(input, env),
    maxResults: collected.maxResults,
    present: shouldPresent,
  }, collected.messages, env, options);
  await appendEvent({
    type: "jobs_gmail_poll_run",
    ownerUserId: collected.ownerUserId,
    query: collected.query,
    collected: collected.messages.length,
    created: result.upserted.created.length,
    duplicates: result.upserted.duplicates.length,
    classified: result.classified.classified.length,
    presented: result.presentation.presented?.length || 0,
  }, env).catch(() => {});
  return {
    ...result,
    query: collected.query,
    resultSizeEstimate: collected.resultSizeEstimate,
    nextPageToken: collected.nextPageToken,
  };
}

export async function runGmailJobsPollForPrincipal(input = {}, principal, env = process.env, fetchImpl = fetch, options = {}) {
  const ownerUserId = ownerUserIdFor(input, principal, env);
  if (!isAdminPrincipal(principal) && !ownerUserId) throw policyError("jobs_queue_owner_required", 403);
  return runGmailJobsPoll({ ...input, ownerUserId }, env, fetchImpl, { ...options, principal });
}

export async function runDueGmailJobsAutomation(env = process.env, now = new Date(), fetchImpl = fetch) {
  if (!jobsAutomationEnabled(env)) return [];
  const settings = await readJobsQueueSettings(env);
  const pausedUntilMs = Date.parse(clean(settings?.pausedUntil));
  if (Number.isFinite(pausedUntilMs) && pausedUntilMs > now.getTime()) return [];
  const nextRunMs = Date.parse(clean(settings?.nextPollAt));
  if (Number.isFinite(nextRunMs) && nextRunMs > now.getTime()) return [];
  const intervalMs = parseIntervalMs(env.ORKESTR_JOBS_POLL_INTERVAL_MS || env.ORKESTR_JOBS_POLL_INTERVAL || "10m", defaultPollIntervalMs);
  try {
    const result = await runGmailJobsPoll({
      ownerUserId: normalizeUserId(env.ORKESTR_JOBS_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId),
      targetThreadId: jobsTargetThreadId({}, env),
      maxResults: env.ORKESTR_JOBS_MAX_ITEMS_PER_RUN,
      fitThreshold: env.ORKESTR_JOBS_FIT_THRESHOLD,
      present: true,
    }, env, fetchImpl, { now });
    await updateJobsQueueSettings({
      lastPollAt: now.toISOString(),
      nextPollAt: new Date(now.getTime() + intervalMs).toISOString(),
      digestIntervalMs: parseIntervalMs(env.ORKESTR_JOBS_DIGEST_INTERVAL_MS || "2h", defaultDigestIntervalMs),
      lastError: "",
    }, env);
    return [result];
  } catch (error) {
    const lastError = clean(error?.message || error).slice(0, 500);
    await updateJobsQueueSettings({
      lastPollAt: now.toISOString(),
      nextPollAt: new Date(now.getTime() + intervalMs).toISOString(),
      lastError,
      lastErrorAt: now.toISOString(),
    }, env);
    await appendEvent({ type: "jobs_gmail_poll_failed", error: lastError }, env).catch(() => {});
    return [{ ok: false, error: lastError }];
  }
}
