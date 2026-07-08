import crypto from "node:crypto";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { isAdminPrincipal } from "./policy.js";
import { normalizeUserId } from "./users.js";

const appTypes = new Set(["people-message-labeling"]);
const defaultLabels = ["not_evaluated", "to_contact", "to_skip"];
const defaultAction = "setClassification";
const defaultXrmReviewApiBaseUrl = "http://127.0.0.1:25995";

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function statePath(env = process.env) {
  return env.ORKESTR_SHARED_APPS_FILE || path.join(dataPaths(env).home, "shared-apps.json");
}

function sharedAppError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function normalizeSharedInstanceId(value = "") {
  return clean(value)
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function normalizeSharedAppSlug(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeId(value = "", fallback = "") {
  return clean(value || fallback)
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function objectValue(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listValue(value = []) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((item) => clean(item)).filter(Boolean))];
}

function jsonObject(value = {}, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return objectValue(parsed);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function jsonArray(value = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function queryValue(value, fallback = "") {
  if (Array.isArray(value)) return value.length ? queryValue(value[0], fallback) : fallback;
  const cleaned = clean(value);
  return cleaned || fallback;
}

function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const cleaned = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(cleaned)) return true;
  if (["0", "false", "no", "off"].includes(cleaned)) return false;
  return fallback;
}

function intValue(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = Number(first);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function normalizeReviewStatus(value = "", fallback = "all") {
  const cleaned = clean(value);
  if (cleaned === "all") return "all";
  if (defaultLabels.includes(cleaned)) return cleaned;
  return fallback;
}

function xrmInstanceApiBaseUrl(app = {}, share = {}, env = process.env) {
  const filters = shareFilters(share);
  const instanceId = clean(app.backingInstanceId || filters.backingInstanceId || filters.xrmInstanceId).toLowerCase();
  const configured = objectValue(jsonObject(env.ORKESTR_SHARED_APPS_XRM_REVIEW_API_BASE_URLS_JSON, {}));
  const defaults = {
    "otcanclaw-linkedin": "http://127.0.0.1:25995",
    "oguzcan-unver-linkedin": "http://127.0.0.1:25995",
    "saim-linkedin": "http://127.0.0.1:48772",
  };
  return clean(
    configured[instanceId] ||
    filters.apiBaseUrl ||
    env.ORKESTR_SHARED_APPS_XRM_REVIEW_API_BASE_URL ||
    env.ORKESTR_XRM_REVIEW_API_BASE_URL ||
    defaults[instanceId] ||
    defaultXrmReviewApiBaseUrl
  ).replace(/\/+$/g, "");
}

function shareFilters(share = {}) {
  return objectValue(share.filtersJson);
}

function isXrmBackedShare(app = {}, share = {}) {
  const filters = shareFilters(share);
  const sources = [
    app.backingSystem,
    filters.backingSystem,
    filters.liveSource,
    filters.source,
  ].map((item) => clean(item).toLowerCase());
  return sources.some((source) => ["xrm", "oxrm"].includes(source));
}

function xrmQueueKey(share = {}) {
  const filters = shareFilters(share);
  return normalizeId(filters.queueKey || filters.queue || share.viewKey);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw sharedAppError(`xrm_review_api_${response.status}${text ? `:${text.slice(0, 180)}` : ""}`, 502);
  }
  return response.json();
}

function mapXrmReviewItem(item = {}) {
  const id = normalizeId(item.recordId || item.id);
  return {
    id,
    name: clean(item.displayName || item.name || id),
    profileUrl: clean(item.profileUrl || item.linkedinUrl || ""),
    headline: clean(item.headline || ""),
    messageCount: Number(item.messageCount || 0),
    matchedMessageCount: Number(item.matchedMessageCount || 0),
    firstMatchAt: clean(item.firstMatchAt || ""),
    lastMatchAt: clean(item.lastMatchAt || ""),
    lastMessagePreview: clean(item.lastMessagePreview || ""),
    currentClassification: normalizeReviewStatus(item.reviewStatus, "not_evaluated"),
    messageHistory: [],
  };
}

function mapXrmReviewMessage(message = {}, index = 0) {
  const id = normalizeId(message.id || `message-${index + 1}`);
  const from = clean(message.fromName || message.from || message.direction || message.channel || "Message");
  return {
    id,
    at: clean(message.occurredAt || message.at || message.createdAt || ""),
    from,
    text: clean(message.messageBody || message.text || message.body || ""),
    direction: clean(message.direction || ""),
    channel: clean(message.channel || ""),
    matched: Boolean(message.matched),
  };
}

async function fetchXrmReviewItems(app = {}, share = {}, query = {}, env = process.env) {
  const filters = shareFilters(share);
  const queueKey = xrmQueueKey(share);
  if (!queueKey) throw sharedAppError("xrm_review_queue_required", 400);
  const limit = intValue(query.limit ?? filters.limit, 50, 1, 200);
  const offset = intValue(query.offset ?? 0, 0, 0, 1_000_000);
  const status = normalizeReviewStatus(queryValue(query.status, filters.status || "all"), "all");
  const q = queryValue(query.q, "");
  const baseUrl = xrmInstanceApiBaseUrl(app, share, env);
  const url = new URL(`${baseUrl}/api/review/queues/${encodeURIComponent(queueKey)}/items`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("status", status);
  if (queryValue(query.sort, "") || boolValue(filters.richerFirst, false)) {
    url.searchParams.set("sort", queryValue(query.sort, "message_count_desc"));
  }
  if (boolValue(query.excludeGeneric ?? filters.excludeGeneric, false)) {
    url.searchParams.set("excludeGeneric", "true");
  }
  if (q) url.searchParams.set("q", q);
  const payload = await fetchJson(url);
  let people = Array.isArray(payload.items) ? payload.items.map(mapXrmReviewItem) : [];
  if (boolValue(query.excludeGeneric ?? filters.excludeGeneric, false)) {
    people = people.filter((person) => !/^linkedin member$/i.test(person.name));
  }
  return {
    people,
    queue: payload.queue || null,
    total: Number(payload.total || people.length),
    limit: Number(payload.limit || limit),
    offset: Number(payload.offset || offset),
    hasNext: offset + people.length < Number(payload.total || people.length),
    status,
    q,
    queueKey,
  };
}

async function fetchXrmReviewMessages(app = {}, share = {}, personId = "", env = process.env) {
  const queueKey = xrmQueueKey(share);
  const id = normalizeId(personId);
  if (!queueKey) throw sharedAppError("xrm_review_queue_required", 400);
  if (!id) throw sharedAppError("person_id_required", 400);
  const baseUrl = xrmInstanceApiBaseUrl(app, share, env);
  const url = new URL(`${baseUrl}/api/review/queues/${encodeURIComponent(queueKey)}/items/${encodeURIComponent(id)}/messages`);
  url.searchParams.set("limit", "200");
  const messages = await fetchJson(url);
  return (Array.isArray(messages) ? messages : []).map(mapXrmReviewMessage);
}

async function writeXrmReviewClassification(app = {}, share = {}, personId = "", classification = "", env = process.env) {
  const queueKey = xrmQueueKey(share);
  const id = normalizeId(personId);
  if (!queueKey) throw sharedAppError("xrm_review_queue_required", 400);
  if (!id) throw sharedAppError("person_id_required", 400);
  const baseUrl = xrmInstanceApiBaseUrl(app, share, env);
  const url = `${baseUrl}/api/review/queues/${encodeURIComponent(queueKey)}/items/${encodeURIComponent(id)}/classification`;
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: classification }),
  });
}

async function readState(env = process.env) {
  const state = await readJson(statePath(env), { apps: [], shares: [] });
  return {
    apps: Array.isArray(state.apps) ? state.apps : [],
    shares: Array.isArray(state.shares) ? state.shares : [],
  };
}

async function writeState(state, env = process.env) {
  await ensureDataDirs(env);
  await writeSecretJson(statePath(env), {
    apps: Array.isArray(state.apps) ? state.apps : [],
    shares: Array.isArray(state.shares) ? state.shares : [],
    updatedAt: nowIso(),
  });
}

function normalizeApp(input = {}, existing = {}) {
  const instanceId = normalizeSharedInstanceId(input.instanceId || existing.instanceId);
  const appSlug = normalizeSharedAppSlug(input.appSlug || existing.appSlug);
  if (!instanceId) throw sharedAppError("instance_id_required", 400);
  if (!appSlug) throw sharedAppError("app_slug_required", 400);
  const createdAt = existing.createdAt || nowIso();
  const appType = clean(input.appType || existing.appType || "people-message-labeling");
  if (!appTypes.has(appType)) throw sharedAppError("unsupported_shared_app_type", 400);
  return {
    id: normalizeId(input.id || existing.id, `${instanceId}-${appSlug}`),
    instanceId,
    appSlug,
    appType,
    title: clean(input.title || existing.title || appSlug.replace(/[-_]+/g, " ")).slice(0, 180),
    description: clean(input.description || existing.description).slice(0, 500),
    backingSystem: clean(input.backingSystem || existing.backingSystem || "native").slice(0, 80),
    backingInstanceId: clean(input.backingInstanceId || existing.backingInstanceId).slice(0, 200),
    createdBy: normalizeUserId(input.createdBy || existing.createdBy || ""),
    createdAt,
    updatedAt: nowIso(),
    archivedAt: clean(input.archivedAt || existing.archivedAt),
  };
}

function normalizeShare(input = {}, app = {}, existing = {}) {
  const instanceId = normalizeSharedInstanceId(input.instanceId || existing.instanceId || app.instanceId);
  const appSlug = normalizeSharedAppSlug(input.appSlug || existing.appSlug || app.appSlug);
  if (!instanceId) throw sharedAppError("instance_id_required", 400);
  if (!appSlug) throw sharedAppError("app_slug_required", 400);
  const token = clean(input.shareToken || input.token);
  const tokenHash = clean(input.tokenHash || existing.tokenHash || (token ? sha256(token) : ""));
  if (!tokenHash) throw sharedAppError("share_token_required", 400);
  const allowedActions = listValue(input.allowedActionsJson ?? input.allowedActions ?? existing.allowedActionsJson ?? existing.allowedActions);
  const createdAt = existing.createdAt || nowIso();
  return {
    id: normalizeId(input.id || existing.id, `share-${randomToken(10)}`),
    tokenHash,
    instanceId,
    appSlug,
    appId: normalizeId(input.appId || existing.appId || app.id),
    viewKey: clean(input.viewKey || existing.viewKey || "default").slice(0, 120),
    viewType: clean(input.viewType || existing.viewType || "people-message-labeling").slice(0, 120),
    filtersJson: jsonObject(input.filtersJson ?? input.filters ?? existing.filtersJson, {}),
    visibleFieldsJson: listValue(input.visibleFieldsJson ?? input.visibleFields ?? existing.visibleFieldsJson),
    allowedActionsJson: allowedActions.length ? allowedActions : [defaultAction],
    expiresAt: clean(input.expiresAt || existing.expiresAt),
    revokedAt: clean(input.revokedAt || existing.revokedAt),
    createdBy: normalizeUserId(input.createdBy || existing.createdBy || ""),
    createdAt,
    updatedAt: nowIso(),
    stateJson: jsonObject(input.stateJson ?? input.state ?? existing.stateJson, {}),
  };
}

function publicApp(app = {}) {
  return {
    id: app.id || "",
    instanceId: app.instanceId || "",
    appSlug: app.appSlug || "",
    appType: app.appType || "",
    title: app.title || "",
    description: app.description || "",
    backingSystem: app.backingSystem || "",
    createdBy: app.createdBy || "",
    createdAt: app.createdAt || "",
    updatedAt: app.updatedAt || "",
    archivedAt: app.archivedAt || "",
  };
}

function publicShare(share = {}, includeToken = "") {
  return {
    id: share.id || "",
    instanceId: share.instanceId || "",
    appSlug: share.appSlug || "",
    appId: share.appId || "",
    viewKey: share.viewKey || "",
    viewType: share.viewType || "",
    filtersJson: share.filtersJson || {},
    visibleFieldsJson: share.visibleFieldsJson || [],
    allowedActionsJson: share.allowedActionsJson || [],
    expiresAt: share.expiresAt || "",
    revokedAt: share.revokedAt || "",
    createdBy: share.createdBy || "",
    createdAt: share.createdAt || "",
    updatedAt: share.updatedAt || "",
    ...(includeToken ? { shareToken: includeToken } : {}),
  };
}

function shareExpired(share = {}, now = Date.now()) {
  if (share.revokedAt) return "revoked";
  if (!share.expiresAt) return "";
  const expiresAt = Date.parse(share.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now ? "expired" : "";
}

function assertAdmin(principal = {}) {
  if (isAdminPrincipal(principal)) return;
  throw sharedAppError("shared_app_admin_required", 403);
}

export async function createSharedApp(input = {}, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const state = await readState(env);
  const app = normalizeApp({ ...input, createdBy: principal?.userId || input.createdBy });
  const withoutExisting = state.apps.filter((item) => !(item.instanceId === app.instanceId && item.appSlug === app.appSlug));
  await writeState({ ...state, apps: [...withoutExisting, app] }, env);
  await appendEvent({ type: "shared_app_created", instanceId: app.instanceId, appSlug: app.appSlug, appId: app.id, actorUserId: principal?.userId || null }, env).catch(() => {});
  return { ok: true, app: publicApp(app) };
}

export async function ensureSharedApp(input = {}, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const state = await readState(env);
  const instanceId = normalizeSharedInstanceId(input.instanceId);
  const appSlug = normalizeSharedAppSlug(input.appSlug);
  const existing = state.apps.find((item) => item.instanceId === instanceId && item.appSlug === appSlug && !item.archivedAt);
  if (existing) return { ok: true, app: publicApp(existing) };
  return createSharedApp(input, { env, principal });
}

export async function listSharedApps({ env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const state = await readState(env);
  return { apps: state.apps.filter((app) => !app.archivedAt).map(publicApp) };
}

export async function createAppShare(instanceId, appSlug, input = {}, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const state = await readState(env);
  const normalizedInstanceId = normalizeSharedInstanceId(instanceId);
  const normalizedAppSlug = normalizeSharedAppSlug(appSlug);
  let app = state.apps.find((item) => item.instanceId === normalizedInstanceId && item.appSlug === normalizedAppSlug && !item.archivedAt);
  if (!app) app = normalizeApp({ instanceId: normalizedInstanceId, appSlug: normalizedAppSlug, appType: input.appType || "people-message-labeling", title: input.title, createdBy: principal?.userId || "" });
  const token = clean(input.shareToken || input.token) || randomToken(24);
  const share = normalizeShare({ ...input, instanceId: normalizedInstanceId, appSlug: normalizedAppSlug, createdBy: principal?.userId || input.createdBy, shareToken: token }, app);
  await writeState({
    apps: state.apps.some((item) => item.id === app.id) ? state.apps : [...state.apps, app],
    shares: [...state.shares, share],
  }, env);
  await appendEvent({ type: "shared_app_share_created", instanceId: share.instanceId, appSlug: share.appSlug, appId: share.appId, shareId: share.id, actorUserId: principal?.userId || null }, env).catch(() => {});
  return { ok: true, app: publicApp(app), share: publicShare(share, token) };
}

export async function listAppShares(instanceId, appSlug, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const normalizedInstanceId = normalizeSharedInstanceId(instanceId);
  const normalizedAppSlug = normalizeSharedAppSlug(appSlug);
  const state = await readState(env);
  return {
    shares: state.shares
      .filter((share) => share.instanceId === normalizedInstanceId && share.appSlug === normalizedAppSlug)
      .map((share) => publicShare(share)),
  };
}

export async function revokeAppShare(instanceId, appSlug, shareId, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const normalizedInstanceId = normalizeSharedInstanceId(instanceId);
  const normalizedAppSlug = normalizeSharedAppSlug(appSlug);
  const id = normalizeId(shareId);
  const state = await readState(env);
  let found = null;
  const shares = state.shares.map((share) => {
    if (share.id !== id || share.instanceId !== normalizedInstanceId || share.appSlug !== normalizedAppSlug) return share;
    found = { ...share, revokedAt: share.revokedAt || nowIso(), updatedAt: nowIso() };
    return found;
  });
  if (!found) throw sharedAppError("shared_app_share_not_found", 404);
  await writeState({ ...state, shares }, env);
  await appendEvent({ type: "shared_app_share_revoked", instanceId: normalizedInstanceId, appSlug: normalizedAppSlug, shareId: id, actorUserId: principal?.userId || null }, env).catch(() => {});
  return { ok: true, share: publicShare(found) };
}

export async function resolveSharedAppShare(instanceId, appSlug, shareToken, { env = process.env, includeDenied = false } = {}) {
  const normalizedInstanceId = normalizeSharedInstanceId(instanceId);
  const normalizedAppSlug = normalizeSharedAppSlug(appSlug);
  const token = clean(shareToken);
  if (!normalizedInstanceId || !normalizedAppSlug || !token) throw sharedAppError("shared_app_share_not_found", 404);
  const state = await readState(env);
  const tokenHash = sha256(token);
  const share = state.shares.find((item) =>
    item.instanceId === normalizedInstanceId &&
    item.appSlug === normalizedAppSlug &&
    item.tokenHash === tokenHash
  );
  if (!share) throw sharedAppError("shared_app_share_not_found", 404);
  const app = state.apps.find((item) => item.id === share.appId && !item.archivedAt) ||
    state.apps.find((item) => item.instanceId === normalizedInstanceId && item.appSlug === normalizedAppSlug && !item.archivedAt);
  if (!app) throw sharedAppError("shared_app_not_found", 404);
  const deniedReason = shareExpired(share);
  if (deniedReason && !includeDenied) throw sharedAppError(`shared_app_share_${deniedReason}`, 403);
  return { app, share, deniedReason };
}

function basePeopleFromShare(share = {}) {
  const filters = objectValue(share.filtersJson);
  const people = jsonArray(filters.people || filters.records || filters.items);
  const state = objectValue(share.stateJson);
  const classifications = objectValue(state.classifications);
  return people.map((person, index) => {
    const source = objectValue(person);
    const id = normalizeId(source.id || source.personId || source.profileUrl || `person-${index + 1}`);
    const messages = jsonArray(source.messages || source.messageHistory || source.history).map((message) => objectValue(message));
    return {
      id,
      name: clean(source.name || source.fullName || source.personName || id),
      profileUrl: clean(source.profileUrl || source.url || source.linkedinUrl),
      messageHistory: messages.map((message, messageIndex) => ({
        id: normalizeId(message.id || `${id}-message-${messageIndex + 1}`),
        at: clean(message.at || message.createdAt || message.date),
        from: clean(message.from || message.sender || message.author),
        text: clean(message.text || message.body || message.message),
      })),
      currentClassification: clean(classifications[id] || source.currentClassification || source.classification || "not_evaluated") || "not_evaluated",
    };
  });
}

async function sharedAppPayload(app = {}, share = {}, { env = process.env, query = {} } = {}) {
  if (app.appType !== "people-message-labeling") {
    throw sharedAppError("unsupported_shared_app_type", 400);
  }
  if (isXrmBackedShare(app, share)) {
    const batch = await fetchXrmReviewItems(app, share, query, env);
    return {
      ok: true,
      app: publicApp(app),
      share: publicShare(share),
      data: {
        people: batch.people,
        labels: defaultLabels,
        allowedActions: share.allowedActionsJson || [],
        liveSource: {
          backingSystem: "xrm",
          queueKey: batch.queueKey,
          generatedAt: nowIso(),
        },
        queue: batch.queue,
        paging: {
          total: batch.total,
          limit: batch.limit,
          offset: batch.offset,
          hasNext: batch.hasNext,
          status: batch.status,
          q: batch.q,
        },
      },
    };
  }
  return {
    ok: true,
    app: publicApp(app),
    share: publicShare(share),
    data: {
      people: basePeopleFromShare(share),
      labels: defaultLabels,
      allowedActions: share.allowedActionsJson || [],
    },
  };
}

export async function sharedAppData(instanceId, appSlug, shareToken, { env = process.env, session = null, query = {} } = {}) {
  const { app, share } = await resolveSharedAppShare(instanceId, appSlug, shareToken, { env });
  assertSessionScope(session, share);
  return sharedAppPayload(app, share, { env, query });
}

export async function sharedAppPersonMessages(instanceId, appSlug, shareToken, personId, { env = process.env, session = null } = {}) {
  const { app, share } = await resolveSharedAppShare(instanceId, appSlug, shareToken, { env });
  assertSessionScope(session, share);
  if (app.appType !== "people-message-labeling") throw sharedAppError("unsupported_shared_app_type", 400);
  const id = normalizeId(personId);
  if (!id) throw sharedAppError("person_id_required", 400);
  if (isXrmBackedShare(app, share)) {
    return { ok: true, personId: id, messages: await fetchXrmReviewMessages(app, share, id, env) };
  }
  const person = basePeopleFromShare(share).find((item) => item.id === id);
  if (!person) throw sharedAppError("person_not_found", 404);
  return { ok: true, personId: id, messages: person.messageHistory || [] };
}

export function assertSessionScope(session = null, share = {}) {
  if (!session?.id) throw sharedAppError("shared_app_session_required", 401);
  if (String(session.instanceId || "") !== String(share.instanceId || "")) throw sharedAppError("shared_app_session_required", 401);
  if (String(session.appSlug || "") !== String(share.appSlug || "")) throw sharedAppError("shared_app_session_required", 401);
  if (String(session.shareId || "") !== String(share.id || "")) throw sharedAppError("shared_app_session_required", 401);
}

export function sessionAllowsShareAction(session = null, action = "") {
  const allowed = Array.isArray(session?.allowedActions) ? session.allowedActions : [];
  return allowed.includes(action);
}

export async function runSharedAppAction(instanceId, appSlug, shareToken, action, body = {}, { env = process.env, session = null } = {}) {
  const { app, share } = await resolveSharedAppShare(instanceId, appSlug, shareToken, { env });
  assertSessionScope(session, share);
  const actionName = clean(action);
  if (actionName !== defaultAction || !sessionAllowsShareAction(session, actionName)) throw sharedAppError("shared_app_action_forbidden", 403);
  if (app.appType !== "people-message-labeling") throw sharedAppError("unsupported_shared_app_type", 400);
  const personId = normalizeId(body.personId || body.id);
  const classification = clean(body.classification || body.value);
  if (!personId) throw sharedAppError("person_id_required", 400);
  if (!defaultLabels.includes(classification)) throw sharedAppError("invalid_classification", 400);
  if (isXrmBackedShare(app, share)) {
    await writeXrmReviewClassification(app, share, personId, classification, env);
    await appendEvent({ type: "shared_app_action", instanceId: share.instanceId, appSlug: share.appSlug, shareId: share.id, action: actionName, personId, classification, backingSystem: "xrm" }, env).catch(() => {});
    return { ok: true, personId, classification };
  }
  const state = await readState(env);
  let updated = null;
  const shares = state.shares.map((item) => {
    if (item.id !== share.id) return item;
    const stateJson = objectValue(item.stateJson);
    const classifications = objectValue(stateJson.classifications);
    updated = {
      ...item,
      stateJson: {
        ...stateJson,
        classifications: {
          ...classifications,
          [personId]: classification,
        },
      },
      updatedAt: nowIso(),
    };
    return updated;
  });
  if (!updated) throw sharedAppError("shared_app_share_not_found", 404);
  await writeState({ ...state, shares }, env);
  await appendEvent({ type: "shared_app_action", instanceId: share.instanceId, appSlug: share.appSlug, shareId: share.id, action: actionName, personId, classification }, env).catch(() => {});
  return { ok: true, personId, classification, data: (await sharedAppPayload(app, updated, { env })).data };
}
