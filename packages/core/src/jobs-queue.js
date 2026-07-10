import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, canAccessOwner, isAdminPrincipal } from "./policy.js";
import { appendThreadSignal, normalizeThreadSignalDeliveryMode } from "./thread-signals.js";
import { getThread, listThreads } from "./threads.js";
import { adminUserId, normalizeUserId } from "./users.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const defaultMaxItemsPerRun = 5;
const defaultFitThreshold = 7;
const queueStates = new Set(["new", "triaging", "queued_fit", "queued_reject", "presented", "dismissed"]);

function clean(value) { return String(value || "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }
function nowIso(now = new Date()) { return now.toISOString(); }

function intValue(value, fallback, min, max) {
  const parsed = Number(value);
  const numeric = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function fitScore100Value(raw = {}, fitScore = 5) {
  const explicit = raw.fit_score_100 ?? raw.fitScore100 ?? raw.score100;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return intValue(explicit, fitScore * 10, 1, 100);
  }
  return intValue(fitScore * 10, 50, 1, 100);
}

function fitScoreBand(score100) {
  const score = intValue(score100, 50, 1, 100);
  if (score >= 90) return "exceptional";
  if (score >= 75) return "strong";
  if (score >= 60) return "possible";
  return "weak";
}

function fitScore100ForDisplay(fit = {}) {
  if (!fit || typeof fit !== "object") return null;
  const hasExplicitScore = fit.fitScore100 !== undefined || fit.fit_score_100 !== undefined || fit.score100 !== undefined
    || fit.fitScore !== undefined || fit.fit_score !== undefined || fit.score !== undefined;
  if (!hasExplicitScore) return null;
  const score100 = fitScore100Value(fit, intValue(fit.fitScore ?? fit.fit_score ?? fit.score, 5, 1, 10));
  return Number.isFinite(score100) ? score100 : null;
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

function queuePath(env = process.env) { return dataPaths(env).jobsQueue; }

async function readQueueStore(env = process.env) {
  const payload = await readJson(queuePath(env), { schemaVersion: 1, candidates: [], settings: {} });
  return {
    schemaVersion: 1,
    candidates: Array.isArray(payload?.candidates) ? payload.candidates.map(normalizeCandidate) : [],
    settings: payload?.settings && typeof payload.settings === "object" ? payload.settings : {},
  };
}

async function writeQueueStore(store, env = process.env) {
  return writeJson(queuePath(env), {
    schemaVersion: 1,
    candidates: Array.isArray(store?.candidates) ? store.candidates.map(normalizeCandidate) : [],
    settings: store?.settings && typeof store.settings === "object" ? store.settings : {},
    updatedAt: nowIso(),
  });
}

function queueError(message, statusCode = 400) {
  const error = new Error(message); error.statusCode = statusCode; return error;
}

function ownerUserIdFor(input = {}, principal = null, env = process.env) {
  if (principal && !isAdminPrincipal(principal)) return normalizeUserId(principal.userId);
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}
function gmailDate(message = {}) {
  const date = clean(message.date);
  if (date) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const internal = Number(message.internalDate || 0);
  return internal ? new Date(internal).toISOString() : "";
}

function extractUrls(text = "") {
  return [...new Set((String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [])
    .map((url) => url.replace(/[.,;:!?]+$/g, "")).filter(Boolean))].slice(0, 12);
}

function canonicalJobUrl(raw = "") {
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith("google.com") && url.pathname === "/url") {
      const target = url.searchParams.get("url") || url.searchParams.get("q");
      if (target) return canonicalJobUrl(target);
    }
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|trk|ref|source)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.toString().replace(/\/$/g, "");
  } catch {
    return "";
  }
}

function companyRoleKey(fit = {}) {
  const company = lower(fit.company).replace(/[^a-z0-9]+/g, " ").trim();
  const role = lower(fit.role).replace(/[^a-z0-9]+/g, " ").trim();
  return company && role ? `company_role:${company}:${role}` : "";
}

function dedupeKeysFor(candidate = {}) {
  const keys = new Set(Array.isArray(candidate.dedupeKeys) ? candidate.dedupeKeys.map(clean).filter(Boolean) : []);
  if (candidate.gmailMessageId) keys.add(`gmail:${candidate.gmailMessageId}`);
  for (const url of candidate.canonicalJobUrls || []) keys.add(`url:${url}`);
  const fitKey = companyRoleKey(candidate.fit || {});
  if (fitKey) keys.add(fitKey);
  return [...keys].slice(0, 40);
}

function normalizeCandidate(candidate = {}) {
  const fit = candidate.fit && typeof candidate.fit === "object" ? candidate.fit : null;
  const state = queueStates.has(lower(candidate.state)) ? lower(candidate.state) : "new";
  const normalized = {
    id: clean(candidate.id) || `job_${randomUUID()}`,
    ownerUserId: normalizeUserId(candidate.ownerUserId || candidate.userId || adminUserId),
    state,
    gmailMessageId: clean(candidate.gmailMessageId || candidate.messageId),
    gmailThreadId: clean(candidate.gmailThreadId || candidate.threadId),
    gmailUrl: clean(candidate.gmailUrl),
    sender: clean(candidate.sender || candidate.from),
    subject: clean(candidate.subject),
    receivedAt: clean(candidate.receivedAt || candidate.date),
    snippet: clean(candidate.snippet).slice(0, 1000),
    bodySnapshot: clean(candidate.bodySnapshot || candidate.text || candidate.body).slice(0, 4000),
    extractedLinks: Array.isArray(candidate.extractedLinks) ? candidate.extractedLinks.map(clean).filter(Boolean).slice(0, 12) : [],
    canonicalJobUrls: Array.isArray(candidate.canonicalJobUrls) ? candidate.canonicalJobUrls.map(clean).filter(Boolean).slice(0, 12) : [],
    duplicateOf: clean(candidate.duplicateOf),
    targetThreadId: clean(candidate.targetThreadId),
    fit,
    createdAt: clean(candidate.createdAt) || nowIso(),
    updatedAt: clean(candidate.updatedAt) || nowIso(),
    lastSeenAt: clean(candidate.lastSeenAt),
    triagedAt: clean(candidate.triagedAt),
    presentedAt: clean(candidate.presentedAt),
    presentationMessageId: clean(candidate.presentationMessageId),
    dismissedAt: clean(candidate.dismissedAt),
    lastError: clean(candidate.lastError).slice(0, 500),
    application: candidate.application && typeof candidate.application === "object" ? {
      state: clean(candidate.application.state),
      updatedAt: clean(candidate.application.updatedAt),
    } : null,
  };
  normalized.dedupeKeys = dedupeKeysFor(normalized);
  return normalized;
}

function candidateFromGmailMessage(message = {}, context = {}, now = new Date()) {
  const text = [message.subject, message.snippet, message.text].map(clean).filter(Boolean).join("\n");
  const extractedLinks = extractUrls(text);
  const canonicalJobUrls = [...new Set(extractedLinks.map(canonicalJobUrl).filter(Boolean))];
  const gmailMessageId = clean(message.id);
  return normalizeCandidate({
    ownerUserId: context.ownerUserId,
    state: "new",
    gmailMessageId,
    gmailThreadId: message.threadId,
    gmailUrl: gmailMessageId ? `https://mail.google.com/mail/u/0/#all/${gmailMessageId}` : "",
    sender: message.from,
    subject: message.subject,
    receivedAt: gmailDate(message) || now.toISOString(),
    snippet: message.snippet,
    bodySnapshot: clean(message.text || message.snippet).slice(0, 4000),
    extractedLinks,
    canonicalJobUrls,
    targetThreadId: context.targetThreadId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

function candidateMatches(left = {}, right = {}) {
  const leftKeys = new Set(dedupeKeysFor(left));
  return dedupeKeysFor(right).some((key) => leftKeys.has(key));
}

function hasJobPostingSignal(text = "") {
  return [
    /\bjob(?:s)?\b/,
    /\bjob alert\b/,
    /\bnew role\b/,
    /\bopen role\b/,
    /\brole at\b/,
    /\bhiring\b/,
    /\brecruiter\b/,
    /\bopportunit(?:y|ies)\b/,
    /\bapply(?: now)?\b/,
    /\bsalary\b/,
    /\bremote\b/,
    /\bhybrid\b/,
    /\bonsite\b/,
    /\/jobs\/view\//,
    /\/jobs\/search\//,
    /\/comm\/jobs\//,
    /\/job\//,
    /\/careers?\//,
    /\/positions?\//,
    /\/openings?\//,
    /greenhouse\.io/,
    /lever\.co/,
    /workdayjobs\.com/,
  ].some((pattern) => pattern.test(text));
}

function obviousNonJobReason(candidate = {}) {
  const text = lower([
    candidate.subject,
    candidate.sender,
    candidate.snippet,
    candidate.bodySnapshot,
    ...(candidate.extractedLinks || []),
    ...(candidate.canonicalJobUrls || []),
  ].join("\n"));
  const linkedinNetworkSuggestion = text.includes("linkedin")
    && (
      /\badd .{1,120} to your network\b/.test(text)
      || text.includes("people you may know")
      || text.includes("/mynetwork/send-invite/")
      || text.includes("email_email_pymk")
    );
  if (linkedinNetworkSuggestion) return "LinkedIn network suggestion, not a job opportunity.";
  const linkedinNonJobNotification = text.includes("linkedin")
    && (
      /\baccepted your invitation\b/.test(text)
      || /\binvitation (?:was )?accepted\b/.test(text)
      || /\byour invitation to connect\b/.test(text)
      || /\bappeared in \d+ searches\b/.test(text)
      || /\byou appeared in searches\b/.test(text)
      || /\bsearch appearances\b/.test(text)
      || /\bviewed your profile\b/.test(text)
      || /\bwho viewed your profile\b/.test(text)
      || /\bwho'?s viewed your profile\b/.test(text)
      || /\bprofile views\b/.test(text)
    );
  if (linkedinNonJobNotification) return "LinkedIn account notification, not a job opportunity.";
  const linkedinWithoutJobSignal = text.includes("linkedin")
    && !hasJobPostingSignal(text)
    && (
      text.includes("unsubscribe")
      || text.includes("manage your email preferences")
      || text.includes("linkedin corporation")
      || text.includes("linkedin member")
      || /messages?-noreply@linkedin\.com/.test(text)
    );
  if (linkedinWithoutJobSignal) return "LinkedIn notification without job-posting signals.";
  return "";
}

async function upsertCandidatesFromMessages(messages = [], context = {}, env = process.env, now = new Date()) {
  const store = await readQueueStore(env);
  const created = [];
  const duplicates = [];
  for (const message of messages) {
    const candidate = candidateFromGmailMessage(message, context, now);
    const existing = store.candidates.find((entry) => canAccessOwner({ role: "user", userId: context.ownerUserId }, entry.ownerUserId, env) && candidateMatches(entry, candidate));
    if (existing) {
      existing.lastSeenAt = now.toISOString();
      existing.updatedAt = now.toISOString();
      existing.dedupeKeys = [...new Set([...(existing.dedupeKeys || []), ...candidate.dedupeKeys])].slice(0, 40);
      existing.extractedLinks = [...new Set([...(existing.extractedLinks || []), ...candidate.extractedLinks])].slice(0, 12);
      existing.canonicalJobUrls = [...new Set([...(existing.canonicalJobUrls || []), ...candidate.canonicalJobUrls])].slice(0, 12);
      duplicates.push({ id: existing.id, gmailMessageId: candidate.gmailMessageId });
    } else {
      store.candidates.push(candidate);
      created.push(candidate);
    }
  }
  await writeQueueStore(store, env);
  return { created, duplicates };
}
function normalizeFitResult(raw = {}, candidate = {}, env = process.env) {
  const result = raw && typeof raw === "object" ? raw : {};
  const fitScore = intValue(result.fit_score ?? result.fitScore ?? result.score, 5, 1, 10);
  const fitScore100 = fitScore100Value(result, fitScore);
  const subjectRole = clean(candidate.subject).replace(/^(new job|job alert|hiring|role)[:\s-]+/i, "").slice(0, 160);
  const senderDomain = clean(candidate.sender).match(/@([^>\s]+)/)?.[1] || "";
  return {
    fitScore,
    fitScore100,
    reason: clean(result.reason).slice(0, 800),
    role: clean(result.role || result.title || subjectRole || "Unknown role").slice(0, 160),
    company: clean(result.company || senderDomain.replace(/^mail\./, "") || "Unknown company").slice(0, 120),
    location: clean(result.location).slice(0, 120),
    remote: clean(result.remote).slice(0, 80),
    salary: clean(result.salary).slice(0, 120),
    whyFit: clean(result.why_fit || result.whyFit).slice(0, 1000),
    risks: clean(Array.isArray(result.risks) ? result.risks.join("; ") : result.risks).slice(0, 1000),
    nextAction: clean(result.next_action || result.nextAction || (fitScore >= jobsFitThreshold(env) ? "review" : "archive")).slice(0, 240),
    classifier: clean(result.classifier || "heuristic"),
    classifiedAt: nowIso(),
  };
}
function heuristicFit(candidate = {}, env = process.env) {
  const text = lower([candidate.subject, candidate.sender, candidate.snippet, candidate.bodySnapshot].join("\n"));
  let score = 5;
  const positives = ["ai", "agent", "automation", "founder", "cto", "head of", "lead", "typescript", "node", "full stack", "product", "platform"];
  const negatives = ["intern", "unpaid", "onsite only", "clearance", "warehouse", "driver", "nurse", "cold calling", "door to door"];
  for (const term of positives) if (text.includes(term)) score += 1;
  for (const term of negatives) if (text.includes(term)) score -= 2;
  if (text.includes("remote")) score += 1;
  if (text.includes("hybrid")) score += 0;
  if (text.includes("onsite") && !text.includes("remote")) score -= 1;
  score = Math.max(1, Math.min(10, score));
  const subject = clean(candidate.subject);
  const atMatch = subject.match(/(.+?)\s+(?:at|@)\s+([^|,-]+)/i);
  return normalizeFitResult({
    fitScore: score,
    role: atMatch ? atMatch[1] : subject,
    company: atMatch ? atMatch[2] : "",
    location: (candidate.bodySnapshot.match(/\b(remote|berlin|munich|london|europe|germany|hybrid|onsite)\b/i) || [])[0] || "",
    remote: text.includes("remote") ? "remote" : text.includes("hybrid") ? "hybrid" : text.includes("onsite") ? "onsite" : "",
    salary: (candidate.bodySnapshot.match(/(?:€|\$|£)\s?[\d.,]+[kK]?[^.\n]{0,40}/) || [])[0] || "",
    reason: score >= jobsFitThreshold(env) ? "Matched job-related terms and profile keywords." : "Low match against profile keywords.",
    whyFit: positives.filter((term) => text.includes(term)).slice(0, 5).join(", "),
    risks: negatives.filter((term) => text.includes(term)).slice(0, 5).join(", "),
    nextAction: score >= jobsFitThreshold(env) ? "review job link" : "keep archived",
    classifier: "heuristic",
  }, candidate, env);
}

function fitAgentCommand(env = process.env) {
  const raw = clean(env.ORKESTR_JOBS_FIT_AGENT_COMMAND_JSON);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : null;
  } catch {
    return null;
  }
}

async function runFitAgentCommand(command, payload, timeoutMs = 45_000) {
  if (!Array.isArray(command) || !command.length) return null;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(queueError("jobs_fit_agent_timeout", 504));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(queueError(clean(stderr) || `jobs_fit_agent_exit_${code}`, 502));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(queueError("jobs_fit_agent_invalid_json", 502));
        }
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function classifyJobCandidate(candidate = {}, preferences = {}, env = process.env, options = {}) {
  const nonJobReason = obviousNonJobReason(candidate);
  if (nonJobReason) {
    return normalizeFitResult({
      fitScore: 1,
      fitScore100: 10,
      reason: nonJobReason,
      role: clean(candidate.subject) || "Non-job Gmail notification",
      company: clean(candidate.sender).match(/@([^>\s]+)/)?.[1] || "Unknown sender",
      risks: "Non-job Gmail notification.",
      nextAction: "archive",
      classifier: "non_job_filter",
    }, candidate, env);
  }
  if (typeof options.classifyImpl === "function") {
    return normalizeFitResult(await options.classifyImpl(candidate, preferences), candidate, env);
  }
  const command = options.fitAgentCommand || fitAgentCommand(env);
  if (command) {
    const payload = { preferences, candidate };
    return normalizeFitResult(await runFitAgentCommand(command, payload, options.fitAgentTimeoutMs), candidate, env);
  }
  return heuristicFit(candidate, env);
}

export function jobsFitThreshold(env = process.env) {
  return intValue(env.ORKESTR_JOBS_FIT_THRESHOLD, defaultFitThreshold, 1, 10);
}

function jobsTargetThreadId(input = {}, env = process.env) {
  return clean(input.targetThreadId || input.threadId || env.ORKESTR_JOBS_TARGET_THREAD_ID || env.ORKESTR_JOBS_THREAD_ID);
}

function jobsSignalMode(input = {}, env = process.env) {
  return normalizeThreadSignalDeliveryMode(input.signalMode || input.signalDeliveryMode || env.ORKESTR_JOBS_SIGNAL_DELIVERY_MODE);
}

async function resolveJobsTargetThread(targetThreadId = "", env = process.env) {
  const requested = clean(targetThreadId);
  if (requested) {
    const thread = await getThread(requested, env);
    if (!thread) throw queueError("jobs_target_thread_not_found", 404);
    return thread;
  }
  const threads = await listThreads(env);
  const match = threads.find((thread) => /\bjobs?\b/i.test([thread.name, thread.title, thread.bindingName].filter(Boolean).join(" ")));
  if (!match) throw queueError("jobs_target_thread_required", 400);
  return match;
}

function threadDeliveryDefaults(thread, input = {}) {
  const binding = thread?.binding || {};
  if (lower(binding.connector) !== "whatsapp" && !binding.chatId) return input;
  return {
    ...input,
    chatId: clean(input.chatId || binding.chatId),
    accountId: clean(input.accountId || binding.responderAccountId || binding.outboundAccountId || binding.senderAccountId || binding.inboundAccountId),
  };
}

function publicCandidate(candidate = {}) {
  return { ...normalizeCandidate(candidate), bodySnapshot: clean(candidate.bodySnapshot).slice(0, 1000) };
}

export async function listJobQueueForPrincipal(principal, env = process.env) {
  const store = await readQueueStore(env);
  const candidates = isAdminPrincipal(principal)
    ? store.candidates
    : store.candidates.filter((candidate) => canAccessOwner(principal, candidate.ownerUserId, env));
  const counts = candidates.reduce((acc, candidate) => {
    acc[candidate.state] = (acc[candidate.state] || 0) + 1;
    return acc;
  }, {});
  return { settings: store.settings, counts, candidates: candidates.map(publicCandidate) };
}

export async function classifyQueuedJobCandidates(input = {}, env = process.env, options = {}) {
  const ownerUserId = normalizeUserId(input.ownerUserId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const limit = intValue(input.limit ?? input.maxItemsPerRun, defaultMaxItemsPerRun, 1, 20);
  const threshold = intValue(input.fitThreshold, jobsFitThreshold(env), 1, 10);
  const store = await readQueueStore(env);
  const selected = store.candidates.filter((candidate) => candidate.ownerUserId === ownerUserId && candidate.state === "new").slice(0, limit);
  const classified = [];
  for (const candidate of selected) {
    candidate.state = "triaging";
    candidate.updatedAt = nowIso();
    try {
      const fit = await classifyJobCandidate(candidate, input.preferences || {}, env, options);
      candidate.fit = fit;
      candidate.state = fit.fitScore >= threshold ? "queued_fit" : "queued_reject";
      candidate.triagedAt = fit.classifiedAt || nowIso();
      candidate.updatedAt = nowIso();
      candidate.dedupeKeys = dedupeKeysFor(candidate);
      classified.push({ id: candidate.id, state: candidate.state, fit });
    } catch (error) {
      candidate.state = "new";
      candidate.lastError = clean(error?.message || error).slice(0, 500);
      candidate.updatedAt = nowIso();
      classified.push({ id: candidate.id, state: candidate.state, error: candidate.lastError });
    }
  }
  await writeQueueStore(store, env);
  return { classified };
}

function formatJobDigest(candidates = [], now = new Date()) {
  const plural = candidates.length === 1 ? "fit" : "fits";
  const lines = [`${candidates.length} new job ${plural} queued at ${now.toLocaleString("en-GB", { hour12: false })}.`];
  lines.push("Fit rubric: 90-100 exceptional, 75-89 strong, 60-74 possible, below 60 weak.");
  candidates.forEach((candidate, index) => {
    const fit = candidate.fit || {};
    const score100 = fitScore100ForDisplay(fit);
    const scoreLabel = score100 ? `${score100}/100 (${fitScoreBand(score100)})` : "score unavailable";
    lines.push("");
    lines.push(`${index + 1}. ${fit.role || candidate.subject || "Unknown role"} at ${fit.company || "Unknown company"} — ${scoreLabel}`);
    if (fit.location || fit.remote || fit.salary) lines.push(`   ${[fit.location, fit.remote, fit.salary].filter(Boolean).join(" | ")}`);
    if (fit.reason) lines.push(`   Reason: ${fit.reason}`);
    if (fit.whyFit) lines.push(`   Why fit: ${fit.whyFit}`);
    if (fit.risks) lines.push(`   Risks: ${fit.risks}`);
    if (fit.nextAction) lines.push(`   Next: ${fit.nextAction}`);
    lines.push(`   Queue ID: ${candidate.id}`);
  });
  return lines.join("\n").slice(0, 8000);
}

export async function presentQueuedJobs(input = {}, env = process.env, options = {}) {
  const ownerUserId = ownerUserIdFor(input, options.principal || null, env);
  const limit = intValue(input.limit ?? input.maxItems ?? defaultMaxItemsPerRun, defaultMaxItemsPerRun, 1, 20);
  const targetThread = await resolveJobsTargetThread(jobsTargetThreadId(input, env), env);
  if (options.principal) assertOwnerAccess(options.principal, targetThread.ownerUserId, "jobs_queue_present", env);
  const store = await readQueueStore(env);
  const candidates = store.candidates
    .filter((candidate) => candidate.ownerUserId === ownerUserId && candidate.state === "queued_fit")
    .slice(0, limit);
  if (!candidates.length) return { ok: true, presented: [], message: null };
  const now = options.now instanceof Date ? options.now : new Date();
  const text = formatJobDigest(candidates, now);
  const signalMode = jobsSignalMode(input, env);
  const message = await appendThreadSignal(targetThread.id, threadDeliveryDefaults(targetThread, {
    source: "jobs_queue",
    connector: "gmail",
    signalKind: "jobs",
    signalMode,
    originSurface: "jobs",
    originTransport: signalMode === "notify_passively" ? "jobs-passive-signal-notify" : "jobs-passive-signal",
    externalId: candidates.map((candidate) => candidate.id).join(",").slice(0, 500),
    ownerUserId,
    text,
  }), env);
  for (const candidate of candidates) {
    candidate.state = "presented";
    candidate.presentedAt = now.toISOString();
    candidate.presentationMessageId = message.id;
    candidate.targetThreadId = targetThread.id;
    candidate.updatedAt = now.toISOString();
  }
  store.settings = { ...(store.settings || {}), lastPresentedAt: now.toISOString(), targetThreadId: targetThread.id };
  await writeQueueStore(store, env);
  await appendEvent({ type: "jobs_queue_presented", ownerUserId, threadId: targetThread.id, count: candidates.length, messageId: message.id }, env).catch(() => {});
  return { ok: true, presented: candidates.map(publicCandidate), message };
}

export async function processJobCandidateMessages(input = {}, messages = [], env = process.env, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const ownerUserId = ownerUserIdFor(input, options.principal || null, env);
  const maxResults = intValue(input.maxResults ?? input.maxItemsPerRun ?? env.ORKESTR_JOBS_MAX_ITEMS_PER_RUN, defaultMaxItemsPerRun, 1, 20);
  const targetThreadId = jobsTargetThreadId(input, env);
  const upserted = await upsertCandidatesFromMessages(Array.isArray(messages) ? messages : [], { ownerUserId, targetThreadId }, env, now);
  const classified = await classifyQueuedJobCandidates({ ownerUserId, limit: maxResults, fitThreshold: input.fitThreshold, preferences: input.preferences }, env, options);
  const shouldPresent = input.present !== false;
  let presentation = { ok: true, presented: [], message: null };
  if (shouldPresent) {
    presentation = await presentQueuedJobs({
      ownerUserId,
      targetThreadId,
      limit: maxResults,
      signalMode: input.signalMode || input.signalDeliveryMode,
    }, env, { ...options, now }).catch((error) => ({ ok: false, presented: [], error: clean(error?.message || error) }));
  }
  await appendEvent({
    type: "jobs_candidate_batch_run",
    ownerUserId,
    collected: messages.length,
    created: upserted.created.length,
    duplicates: upserted.duplicates.length,
    classified: classified.classified.length,
    presented: presentation.presented?.length || 0,
  }, env).catch(() => {});
  return { ok: true, collected: messages.length, upserted, classified, presentation };
}

export async function updateJobCandidateStateForPrincipal(candidateId, patch = {}, principal, env = process.env) {
  const store = await readQueueStore(env);
  const candidate = store.candidates.find((entry) => entry.id === clean(candidateId));
  if (!candidate) throw queueError("job_candidate_not_found", 404);
  assertOwnerAccess(principal, candidate.ownerUserId, "jobs_queue_update", env);
  const state = lower(patch.state);
  if (state && !queueStates.has(state)) throw queueError("job_candidate_state_invalid");
  if (state) candidate.state = state;
  if (state === "dismissed") candidate.dismissedAt = nowIso();
  if (patch.applicationState) {
    candidate.application = {
      state: clean(patch.applicationState),
      updatedAt: nowIso(),
    };
  }
  candidate.updatedAt = nowIso();
  await writeQueueStore(store, env);
  return publicCandidate(candidate);
}

export async function pauseJobsQueueForPrincipal(input = {}, principal, env = process.env) {
  const ownerUserId = ownerUserIdFor(input, principal, env);
  assertOwnerAccess(principal, ownerUserId, "jobs_queue_pause", env);
  const durationMs = parseIntervalMs(input.duration || input.pauseFor || input.until, 6 * hourMs);
  const pausedUntil = input.until && Date.parse(clean(input.until))
    ? new Date(clean(input.until)).toISOString()
    : new Date(Date.now() + durationMs).toISOString();
  const store = await readQueueStore(env);
  store.settings = { ...(store.settings || {}), pausedUntil, pausedOwnerUserId: ownerUserId };
  await writeQueueStore(store, env);
  return { ok: true, pausedUntil };
}

export async function readJobsQueueSettings(env = process.env) { return (await readQueueStore(env)).settings; }

export async function updateJobsQueueSettings(patch = {}, env = process.env) {
  const store = await readQueueStore(env);
  store.settings = { ...(store.settings || {}), ...(patch && typeof patch === "object" ? patch : {}) };
  await writeQueueStore(store, env);
  return store.settings;
}
