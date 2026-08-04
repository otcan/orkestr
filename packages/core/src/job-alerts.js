import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, canAccessOwner, isAdminPrincipal } from "./policy.js";
import { adminPrincipal } from "./principal.js";
import { processJobCandidateMessages } from "./jobs-queue.js";
import { getThreadForPrincipal } from "./threads.js";
import { adminUserId, normalizeUserId } from "./users.js";

function clean(value = "") { return String(value || "").trim(); }
function lower(value = "") { return clean(value).toLowerCase(); }
function nowIso(now = new Date()) { return now.toISOString(); }

function jobAlertError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function routesPath(env = process.env) { return dataPaths(env).jobAlertRoutes; }

function normalizedDomain(value = "") {
  const domain = lower(value).replace(/^@+/, "").replace(/\.+$/, "");
  if (!domain) return "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return "";
  return domain;
}

export function jobAlertInboundDomain(env = process.env) {
  return normalizedDomain(env.ORKESTR_JOB_ALERT_INBOUND_DOMAIN || env.JOB_ALERT_INBOUND_DOMAIN);
}

function normalizeRecipient(value = "") {
  const text = clean(value).toLowerCase();
  const bracket = text.match(/<([^>]+)>/);
  const email = clean(bracket ? bracket[1] : text).replace(/^mailto:/, "");
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email)) return "";
  return email;
}

function routeToken() {
  return crypto.randomBytes(20).toString("hex");
}

function routeAddress(token, domain) {
  return `jobs+${token}@${domain}`;
}

function normalizeRoute(route = {}) {
  return {
    id: clean(route.id) || randomUUID(),
    ownerUserId: normalizeUserId(route.ownerUserId || route.userId || adminUserId),
    targetThreadId: clean(route.targetThreadId || route.threadId),
    label: clean(route.label).slice(0, 120),
    address: normalizeRecipient(route.address),
    createdAt: clean(route.createdAt) || nowIso(),
    updatedAt: clean(route.updatedAt) || nowIso(),
    lastReceivedAt: clean(route.lastReceivedAt),
    receivedCount: Math.max(0, Number(route.receivedCount || 0) || 0),
    disabledAt: clean(route.disabledAt),
  };
}

async function readRouteStore(env = process.env) {
  const payload = await readJson(routesPath(env), { schemaVersion: 1, routes: [] });
  return {
    schemaVersion: 1,
    routes: Array.isArray(payload?.routes) ? payload.routes.map(normalizeRoute).filter((route) => route.address && route.targetThreadId) : [],
  };
}

async function writeRouteStore(store, env = process.env) {
  await writeJson(routesPath(env), {
    schemaVersion: 1,
    routes: Array.isArray(store?.routes) ? store.routes.map(normalizeRoute) : [],
    updatedAt: nowIso(),
  });
}

function publicRoute(route = {}) {
  const normalized = normalizeRoute(route);
  return {
    id: normalized.id,
    targetThreadId: normalized.targetThreadId,
    label: normalized.label,
    address: normalized.address,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    lastReceivedAt: normalized.lastReceivedAt || null,
    receivedCount: normalized.receivedCount,
    enabled: !normalized.disabledAt,
  };
}

function publicInboundConfig(env = process.env) {
  const domain = jobAlertInboundDomain(env);
  return {
    domain: domain || null,
    configured: Boolean(domain),
    relayConfigured: Boolean(domain && clean(env.ORKESTR_JOB_ALERT_RELAY_TOKEN || env.JOB_ALERT_RELAY_TOKEN)),
    relayEndpoint: "/api/jobs/inbound-email",
  };
}

function ownerFor(principal, input = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) return normalizeUserId(principal?.userId);
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

async function assertThreadOwner(targetThreadId, principal, env = process.env) {
  const thread = await getThreadForPrincipal(targetThreadId, principal, env);
  assertOwnerAccess(principal, thread.ownerUserId, "job_alert_route", env);
  return thread;
}

export async function listJobAlertRoutesForPrincipal(principal, env = process.env) {
  const store = await readRouteStore(env);
  const routes = isAdminPrincipal(principal)
    ? store.routes
    : store.routes.filter((route) => canAccessOwner(principal, route.ownerUserId, env));
  return { routes: routes.map(publicRoute), inbound: publicInboundConfig(env) };
}

export async function createJobAlertRouteForPrincipal(input = {}, principal, env = process.env) {
  const domain = jobAlertInboundDomain(env);
  if (!domain) throw jobAlertError("job_alert_inbound_domain_required", 409);
  const targetThreadId = clean(input.targetThreadId || input.threadId);
  if (!targetThreadId) throw jobAlertError("job_alert_target_thread_required");
  const thread = await assertThreadOwner(targetThreadId, principal, env);
  const ownerUserId = ownerFor(principal, input, env);
  if (thread.ownerUserId !== ownerUserId) throw jobAlertError("job_alert_target_thread_owner_mismatch", 403);
  const store = await readRouteStore(env);
  const rotate = input.rotate === true || input.rotate === "true";
  const existing = store.routes.find((route) => route.ownerUserId === ownerUserId && route.targetThreadId === thread.id && !route.disabledAt);
  if (existing && !rotate) return { route: publicRoute(existing), created: false, inbound: publicInboundConfig(env) };
  if (existing && rotate) {
    existing.disabledAt = nowIso();
    existing.updatedAt = nowIso();
  }
  const token = routeToken();
  const route = normalizeRoute({
    id: randomUUID(),
    ownerUserId,
    targetThreadId: thread.id,
    label: clean(input.label || thread.name || thread.title || "Job alerts"),
    address: routeAddress(token, domain),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  store.routes.push(route);
  await writeRouteStore(store, env);
  await appendEvent({ type: "job_alert_route_created", routeId: route.id, ownerUserId, threadId: thread.id }, env).catch(() => {});
  return { route: publicRoute(route), created: true, inbound: publicInboundConfig(env) };
}

function inboundText(input = {}) {
  return clean(input.text || input.plainText || input.body || input.snippet).replace(/\u0000/g, "").slice(0, 20_000);
}

function inboundMessageId(input = {}, recipient = "", text = "") {
  const explicit = clean(input.messageId || input.id || input.externalMessageId || input["message-id"]);
  if (explicit) return explicit.slice(0, 500);
  const fingerprint = [recipient, clean(input.from), clean(input.subject), text, clean(input.receivedAt || input.date)].join("\n");
  return `content-${crypto.createHash("sha256").update(fingerprint).digest("hex")}`;
}

function inboundMessage(input = {}, recipient = "") {
  const text = inboundText(input);
  return {
    id: inboundMessageId(input, recipient, text),
    threadId: clean(input.threadId || input.externalThreadId),
    source: "job_alert_email",
    sourceUrl: clean(input.sourceUrl),
    from: clean(input.from || input.sender).slice(0, 500),
    subject: clean(input.subject).slice(0, 500),
    snippet: clean(input.snippet || text).slice(0, 1000),
    text,
    date: clean(input.receivedAt || input.date),
  };
}

export async function ingestJobAlertEmail(input = {}, env = process.env, options = {}) {
  const recipient = normalizeRecipient(input.to || input.recipient || input.deliveredTo);
  if (!recipient) throw jobAlertError("job_alert_recipient_required");
  const store = await readRouteStore(env);
  const route = store.routes.find((entry) => entry.address === recipient);
  if (!route) throw jobAlertError("job_alert_recipient_not_found", 404);
  if (route.disabledAt) throw jobAlertError("job_alert_recipient_disabled", 410);
  const message = inboundMessage(input, recipient);
  if (!message.subject && !message.text) throw jobAlertError("job_alert_message_empty");
  const thread = await assertThreadOwner(route.targetThreadId, adminPrincipal({ id: route.ownerUserId, role: "admin" }), env);
  if (thread.ownerUserId !== route.ownerUserId) throw jobAlertError("job_alert_target_thread_owner_mismatch", 409);
  const result = await processJobCandidateMessages({
    ownerUserId: route.ownerUserId,
    targetThreadId: thread.id,
    maxResults: 1,
    source: "job_alert_email",
    signalSource: "job_alert_email",
    connector: "job_alert_email",
    originSurface: "job_alerts",
    originTransport: "job-alert-passive-signal",
    signalMode: input.signalMode || "notify_passively",
    present: input.present !== false,
    onlyCreatedCandidates: true,
  }, [message], env, { ...options, disableFitAgent: true });
  route.lastReceivedAt = nowIso();
  route.updatedAt = nowIso();
  route.receivedCount += 1;
  await writeRouteStore(store, env);
  await appendEvent({
    type: "job_alert_email_ingested",
    routeId: route.id,
    ownerUserId: route.ownerUserId,
    threadId: route.targetThreadId,
    messageId: message.id,
    created: result.upserted.created.length,
    duplicates: result.upserted.duplicates.length,
    presented: result.presentation.presented?.length || 0,
  }, env).catch(() => {});
  return { ok: true, route: publicRoute(route), messageId: message.id, result };
}

export async function testJobAlertRouteForPrincipal(routeId, principal, env = process.env, options = {}) {
  const store = await readRouteStore(env);
  const route = store.routes.find((entry) => entry.id === clean(routeId));
  if (!route) throw jobAlertError("job_alert_route_not_found", 404);
  assertOwnerAccess(principal, route.ownerUserId, "job_alert_route_test", env);
  return ingestJobAlertEmail({
    to: route.address,
    from: "alerts@orkestr.example",
    subject: "Product Engineer at ExampleCo",
    text: "Remote product engineering role. Review https://jobs.example.com/exampleco/product-engineer",
    messageId: `job-alert-test-${randomUUID()}`,
  }, env, options);
}
