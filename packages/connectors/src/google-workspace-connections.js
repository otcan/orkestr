import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths } from "./connector-storage.js";
import {
  readEncryptedConnectorRecord,
  writeEncryptedConnectorRecord,
} from "./encrypted-connector-record.js";

const registryFileName = "google-workspace-connections.json";
const legacyTokenFileName = "gmail-token.json";
const tokenDirectoryName = "google-workspace-connections";
const validUseModes = new Set(["default", "available", "explicit_only"]);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function connectionError(code, statusCode = 400, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function normalizeUseMode(value = "", fallback = "available") {
  const normalized = lower(value);
  return validUseModes.has(normalized) ? normalized : fallback;
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function ownerUserId(scope = {}, options = {}, env = process.env) {
  return clean(scope.userId || options.principal?.userId || options.principal?.id || options.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
}

function emptyRegistry(scope = {}, options = {}, env = process.env) {
  return {
    schemaVersion: 1,
    ownerUserId: ownerUserId(scope, options, env),
    mainConnectionId: "",
    threadDefaults: {},
    connections: [],
    updatedAt: "",
  };
}

function normalizeConnection(connection = {}) {
  const connectionId = clean(connection.connectionId || connection.accountId);
  return {
    connectionId,
    accountId: connectionId,
    provider: "google_workspace",
    ownerUserId: clean(connection.ownerUserId),
    alias: clean(connection.alias),
    email: lower(connection.email || connection.account),
    oauthAppId: lower(connection.oauthAppId || connection.oauth_app),
    useMode: normalizeUseMode(connection.useMode, "available"),
    capabilities: unique(connection.capabilities),
    grantedScopes: unique(connection.grantedScopes),
    tokenRef: clean(connection.tokenRef),
    healthState: clean(connection.healthState || "connected"),
    createdAt: clean(connection.createdAt),
    updatedAt: clean(connection.updatedAt),
    lastValidatedAt: clean(connection.lastValidatedAt),
    lastErrorCode: clean(connection.lastErrorCode),
  };
}

function normalizeRegistry(raw = {}, scope = {}, options = {}, env = process.env) {
  const normalizedConnections = (Array.isArray(raw.connections) ? raw.connections : [])
    .map(normalizeConnection)
    .filter((connection) => connection.connectionId);
  const ids = new Set(normalizedConnections.map((connection) => connection.connectionId));
  const mainConnectionId = ids.has(clean(raw.mainConnectionId)) ? clean(raw.mainConnectionId) : "";
  const connections = normalizedConnections.map((connection) => ({
    ...connection,
    useMode: connection.connectionId === mainConnectionId
      ? "default"
      : connection.useMode === "default" ? "available" : connection.useMode,
  }));
  const threadDefaults = Object.fromEntries(
    Object.entries(raw.threadDefaults && typeof raw.threadDefaults === "object" ? raw.threadDefaults : {})
      .map(([threadId, connectionId]) => [clean(threadId), clean(connectionId)])
      .filter(([threadId, connectionId]) => threadId && ids.has(connectionId)),
  );
  return {
    schemaVersion: 1,
    ownerUserId: clean(raw.ownerUserId) || ownerUserId(scope, options, env),
    mainConnectionId,
    threadDefaults,
    connections,
    updatedAt: clean(raw.updatedAt),
  };
}

function registryPath(scope) {
  return connectorFile(scope, "oauth", registryFileName);
}

function tokenRef(connectionId = "") {
  return `${tokenDirectoryName}/${clean(connectionId)}.json`;
}

function tokenPath(scope, reference = "") {
  const resolved = path.resolve(scope.secrets, clean(reference));
  const root = path.resolve(scope.secrets);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw connectionError("google_workspace_token_ref_invalid", 500);
  }
  return resolved;
}

async function readRegistry(scope, options = {}, env = process.env) {
  const raw = await readJson(registryPath(scope), {});
  return normalizeRegistry(raw, scope, options, env);
}

async function writeRegistry(scope, registry) {
  const normalized = normalizeRegistry({ ...registry, updatedAt: nowIso() }, scope);
  await writeJson(registryPath(scope), normalized);
  return normalized;
}

function legacyConnectionId(scope = {}, token = {}, options = {}, env = process.env) {
  const identity = lower(token.account || token.email) || ownerUserId(scope, options, env) || "global";
  return `legacy-${createHash("sha256").update(`google-workspace:${identity}`).digest("hex").slice(0, 20)}`;
}

function hasToken(token = {}) {
  return Boolean(clean(token.accessToken || token.access_token || token.refreshToken || token.refresh_token));
}

export async function migrateLegacyGoogleWorkspaceConnection(env = process.env, options = {}) {
  const scope = await connectorScopePaths(env, options);
  let registry = await readRegistry(scope, options, env);
  if (registry.connections.length) return { migrated: false, registry, scope };
  const legacyPath = connectorFile(scope, "secrets", legacyTokenFileName);
  const legacyToken = await readJson(legacyPath, {});
  if (!hasToken(legacyToken)) return { migrated: false, registry, scope };

  const connectionId = legacyConnectionId(scope, legacyToken, options, env);
  const reference = tokenRef(connectionId);
  const email = lower(legacyToken.account || legacyToken.email);
  const timestamp = clean(legacyToken.updatedAt) || nowIso();
  const connection = normalizeConnection({
    connectionId,
    ownerUserId: ownerUserId(scope, options, env),
    alias: email || "main",
    email,
    useMode: "default",
    capabilities: legacyToken.capabilities,
    grantedScopes: legacyToken.grantedScopes,
    tokenRef: reference,
    healthState: "connected",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await writeEncryptedConnectorRecord(
    tokenPath(scope, reference),
    { ...legacyToken, connectionId, accountId: connectionId },
    env,
  );
  registry = await writeRegistry(scope, {
    ...registry,
    mainConnectionId: connectionId,
    connections: [connection],
  });
  await fs.rm(legacyPath, { force: true });
  return { migrated: true, registry, scope, connection };
}

async function repository(env = process.env, options = {}) {
  const migrated = await migrateLegacyGoogleWorkspaceConnection(env, options);
  return { scope: migrated.scope, registry: migrated.registry };
}

export function publicGoogleWorkspaceConnection(connection = {}, options = {}) {
  const normalized = normalizeConnection(connection);
  return {
    connectionId: normalized.connectionId,
    accountId: normalized.accountId,
    provider: normalized.provider,
    alias: normalized.alias,
    email: normalized.email,
    oauthAppId: normalized.oauthAppId,
    useMode: normalized.useMode,
    capabilities: normalized.capabilities,
    grantedScopes: normalized.grantedScopes,
    healthState: normalized.healthState,
    isMain: clean(options.mainConnectionId) === normalized.connectionId,
    isThreadDefault: clean(options.threadDefaultConnectionId) === normalized.connectionId,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    lastValidatedAt: normalized.lastValidatedAt,
    lastErrorCode: normalized.lastErrorCode,
  };
}

export async function listGoogleWorkspaceConnections(env = process.env, options = {}) {
  const { registry } = await repository(env, options);
  const threadId = clean(options.threadId);
  const explicitLookup = clean(options.connectionId || options.accountId || options.account || options.alias);
  const threadDefaultConnectionId = clean(registry.threadDefaults[threadId]);
  const connections = registry.connections
    .filter((connection) =>
      options.includeExplicit === true ||
      connection.useMode !== "explicit_only" ||
      connection.connectionId === threadDefaultConnectionId ||
      (explicitLookup && connectionMatches(connection, explicitLookup))
    )
    .map((connection) => publicGoogleWorkspaceConnection(connection, {
      mainConnectionId: registry.mainConnectionId,
      threadDefaultConnectionId,
    }));
  return {
    connections,
    mainConnectionId: registry.mainConnectionId,
    threadDefaultConnectionId,
  };
}

function connectionMatches(connection = {}, lookup = "") {
  const needle = lower(lookup);
  if (!needle) return false;
  return [connection.connectionId, connection.accountId, connection.alias, connection.email]
    .some((value) => lower(value) === needle);
}

function safeChoices(registry = {}, threadId = "") {
  const threadDefault = clean(registry.threadDefaults?.[clean(threadId)]);
  return registry.connections
    .filter((connection) => connection.useMode !== "explicit_only" || connection.connectionId === threadDefault)
    .map((connection) => publicGoogleWorkspaceConnection(connection, {
      mainConnectionId: registry.mainConnectionId,
      threadDefaultConnectionId: threadDefault,
    }));
}

export async function resolveGoogleWorkspaceConnection(input = {}, env = process.env, options = {}) {
  const { scope, registry } = await repository(env, options);
  const threadId = clean(input.threadId || options.threadId);
  const explicitLookup = clean(input.connectionId || input.accountId || input.account || input.alias);
  let connection = null;
  let selectionSource = "";
  if (explicitLookup) {
    connection = registry.connections.find((candidate) => connectionMatches(candidate, explicitLookup)) || null;
    if (!connection) {
      throw connectionError("connector_account_not_found", 404, { accountId: explicitLookup });
    }
    selectionSource = "explicit";
  } else {
    const threadDefault = clean(registry.threadDefaults[threadId]);
    if (threadDefault) {
      connection = registry.connections.find((candidate) => candidate.connectionId === threadDefault) || null;
      selectionSource = connection ? "thread_default" : "";
    }
    if (!connection && registry.mainConnectionId) {
      connection = registry.connections.find((candidate) => candidate.connectionId === registry.mainConnectionId) || null;
      selectionSource = connection ? "user_default" : "";
    }
  }
  if (!connection) {
    throw connectionError("connector_selection_required", 409, {
      selectionSource: "selection_required",
      choices: safeChoices(registry, threadId),
    });
  }
  const token = await readEncryptedConnectorRecord(tokenPath(scope, connection.tokenRef), {}, env);
  if (options.allowUnhealthy !== true && (!hasToken(token) || ["revoked", "disconnected", "reauth_required"].includes(connection.healthState))) {
    throw connectionError("reconnect_required", 403, {
      connection: publicGoogleWorkspaceConnection(connection),
      selectionSource,
    });
  }
  return {
    connection: publicGoogleWorkspaceConnection(connection, {
      mainConnectionId: registry.mainConnectionId,
      threadDefaultConnectionId: registry.threadDefaults[threadId],
    }),
    token: { ...token, connectionId: connection.connectionId, accountId: connection.connectionId },
    selectionSource,
  };
}

export async function readGoogleWorkspaceConnectionToken(env = process.env, options = {}) {
  return resolveGoogleWorkspaceConnection(options, env, options);
}

export async function saveGoogleWorkspaceConnectionToken(token = {}, env = process.env, options = {}) {
  const { scope, registry } = await repository(env, options);
  const verifiedEmail = lower(options.verifiedEmail || token.account || token.email);
  const requestedId = clean(options.connectionId || options.accountId);
  let existing = requestedId
    ? registry.connections.find((connection) => connection.connectionId === requestedId)
    : verifiedEmail
      ? registry.connections.find((connection) => connection.email === verifiedEmail)
      : null;
  if (requestedId && !existing) throw connectionError("connector_account_not_found", 404, { accountId: requestedId });
  const duplicate = verifiedEmail
    ? registry.connections.find((connection) => connection.email === verifiedEmail && connection.connectionId !== existing?.connectionId)
    : null;
  if (duplicate) throw connectionError("google_workspace_provider_identity_exists", 409, { accountId: duplicate.connectionId });

  const connectionId = existing?.connectionId || randomUUID();
  const alias = clean(options.alias || existing?.alias || verifiedEmail || `google-${registry.connections.length + 1}`);
  const aliasDuplicate = registry.connections.find((connection) => lower(connection.alias) === lower(alias) && connection.connectionId !== connectionId);
  if (aliasDuplicate) throw connectionError("google_workspace_alias_exists", 409, { accountId: aliasDuplicate.connectionId });
  const requestedUseMode = clean(options.useMode);
  const shouldBeMain = options.setAsMain === true || normalizeUseMode(requestedUseMode, "") === "default" || (
    !registry.mainConnectionId &&
    registry.connections.length === 0 &&
    !requestedUseMode
  );
  const useMode = shouldBeMain
    ? "default"
    : normalizeUseMode(options.useMode, existing?.useMode || "available");
  const timestamp = nowIso();
  const reference = existing?.tokenRef || tokenRef(connectionId);
  const connection = normalizeConnection({
    ...existing,
    connectionId,
    ownerUserId: ownerUserId(scope, options, env),
    alias,
    email: verifiedEmail || existing?.email,
    oauthAppId: lower(options.oauthAppId || token.oauthAppId || existing?.oauthAppId),
    useMode,
    capabilities: token.capabilities || existing?.capabilities,
    grantedScopes: token.grantedScopes || existing?.grantedScopes,
    tokenRef: reference,
    healthState: "connected",
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    lastValidatedAt: clean(options.lastValidatedAt || existing?.lastValidatedAt),
  });
  await writeEncryptedConnectorRecord(
    tokenPath(scope, reference),
    {
      ...token,
      account: connection.email,
      email: connection.email,
      oauthAppId: connection.oauthAppId,
      connectionId,
      accountId: connectionId,
    },
    env,
  );
  const connections = registry.connections
    .filter((candidate) => candidate.connectionId !== connectionId)
    .map((candidate) => shouldBeMain && candidate.useMode === "default" ? { ...candidate, useMode: "available" } : candidate);
  connections.push(connection);
  const threadId = clean(options.threadId);
  const threadDefaults = { ...registry.threadDefaults };
  if (options.setAsThreadDefault === true && threadId) threadDefaults[threadId] = connectionId;
  const updatedRegistry = await writeRegistry(scope, {
    ...registry,
    mainConnectionId: shouldBeMain ? connectionId : registry.mainConnectionId,
    threadDefaults,
    connections,
  });
  return {
    token: {
      ...token,
      account: connection.email,
      email: connection.email,
      oauthAppId: connection.oauthAppId,
      connectionId,
      accountId: connectionId,
    },
    connection: publicGoogleWorkspaceConnection(connection, {
      mainConnectionId: updatedRegistry.mainConnectionId,
      threadDefaultConnectionId: updatedRegistry.threadDefaults[threadId],
    }),
  };
}

export async function updateGoogleWorkspaceConnection(connectionId = "", patch = {}, env = process.env, options = {}) {
  const { scope, registry } = await repository(env, options);
  const id = clean(connectionId);
  const existing = registry.connections.find((connection) => connection.connectionId === id);
  if (!existing) throw connectionError("connector_account_not_found", 404, { accountId: id });
  const alias = clean(patch.alias || existing.alias);
  if (registry.connections.some((connection) => connection.connectionId !== id && lower(connection.alias) === lower(alias))) {
    throw connectionError("google_workspace_alias_exists", 409);
  }
  const requestedUseMode = clean(patch.useMode);
  const setAsMain = patch.setAsMain === true || normalizeUseMode(requestedUseMode, "") === "default";
  const isCurrentMain = registry.mainConnectionId === id;
  const updated = normalizeConnection({
    ...existing,
    alias,
    useMode: setAsMain || isCurrentMain ? "default" : normalizeUseMode(requestedUseMode, existing.useMode),
    healthState: clean(patch.healthState || existing.healthState),
    lastErrorCode: patch.lastErrorCode === "" ? "" : clean(patch.lastErrorCode || existing.lastErrorCode),
    lastValidatedAt: clean(patch.lastValidatedAt || existing.lastValidatedAt),
    updatedAt: nowIso(),
  });
  const connections = registry.connections.map((connection) => {
    if (connection.connectionId === id) return updated;
    if (setAsMain && connection.useMode === "default") return { ...connection, useMode: "available" };
    return connection;
  });
  const threadDefaults = { ...registry.threadDefaults };
  const threadId = clean(patch.threadId || options.threadId);
  if (patch.setAsThreadDefault === true && threadId) threadDefaults[threadId] = id;
  if (patch.clearThreadDefault === true && threadId) delete threadDefaults[threadId];
  const next = await writeRegistry(scope, {
    ...registry,
    mainConnectionId: setAsMain ? id : registry.mainConnectionId,
    threadDefaults,
    connections,
  });
  return publicGoogleWorkspaceConnection(updated, {
    mainConnectionId: next.mainConnectionId,
    threadDefaultConnectionId: next.threadDefaults[threadId],
  });
}

export async function removeGoogleWorkspaceConnection(connectionId = "", env = process.env, options = {}) {
  const { scope, registry } = await repository(env, options);
  const id = clean(connectionId);
  const existing = registry.connections.find((connection) => connection.connectionId === id);
  if (!existing) throw connectionError("connector_account_not_found", 404, { accountId: id });
  await fs.rm(tokenPath(scope, existing.tokenRef), { force: true });
  const connections = registry.connections.filter((connection) => connection.connectionId !== id);
  const threadDefaults = Object.fromEntries(Object.entries(registry.threadDefaults).filter(([, value]) => value !== id));
  await writeRegistry(scope, {
    ...registry,
    mainConnectionId: registry.mainConnectionId === id ? "" : registry.mainConnectionId,
    threadDefaults,
    connections,
  });
  return { ok: true, connection: publicGoogleWorkspaceConnection(existing) };
}
