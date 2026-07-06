import crypto from "node:crypto";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { isAdminPrincipal } from "./policy.js";
import { normalizeUserId } from "./users.js";

const appTypes = new Set(["people-message-labeling"]);
const defaultLabels = ["not_evaluated", "to_contact", "to_skip"];
const defaultAction = "setClassification";

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

function sharedAppPayload(app = {}, share = {}) {
  if (app.appType !== "people-message-labeling") {
    throw sharedAppError("unsupported_shared_app_type", 400);
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

export async function sharedAppData(instanceId, appSlug, shareToken, { env = process.env, session = null } = {}) {
  const { app, share } = await resolveSharedAppShare(instanceId, appSlug, shareToken, { env });
  assertSessionScope(session, share);
  return sharedAppPayload(app, share);
}

export function assertSessionScope(session = null, share = {}) {
  if (!session?.id) throw sharedAppError("shared_app_session_required", 401);
  if (String(session.instanceId || "") !== String(share.instanceId || "")) throw sharedAppError("shared_app_session_scope_denied", 403);
  if (String(session.appSlug || "") !== String(share.appSlug || "")) throw sharedAppError("shared_app_session_scope_denied", 403);
  if (String(session.shareId || "") !== String(share.id || "")) throw sharedAppError("shared_app_session_scope_denied", 403);
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
  return { ok: true, personId, classification, data: sharedAppPayload(app, updated).data };
}
