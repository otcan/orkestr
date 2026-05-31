import { userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, isAdminPrincipal } from "./policy.js";
import { getTenantVmForOwner } from "./tenant-vm-registry.js";
import { getUser, normalizeUserId } from "./users.js";

const skillDefinitions = [
  {
    id: "whereiam",
    label: "Runtime Context",
    category: "runtime",
    summary: "Let the agent discover its current Orkestr thread, workspace, owner, and safe capability hints.",
    enabledByDefault: true,
    scopes: ["own_context"],
  },
  {
    id: "files",
    label: "Files",
    category: "workspace",
    summary: "Let the agent browse and manage files inside the user's scoped workspace and file area.",
    enabledByDefault: true,
    scopes: ["own_workspace"],
  },
  {
    id: "timers",
    label: "Timers",
    category: "automation",
    summary: "Let the user create and manage scoped scheduled prompts.",
    enabledByDefault: true,
    scopes: ["own_timers"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    category: "connector",
    summary: "Route messages through the user's assigned WhatsApp identity or tenant chat.",
    enabledByDefault: true,
    scopes: ["own_connectors"],
    requiresConnector: "whatsapp",
  },
  {
    id: "gmail",
    label: "Gmail",
    category: "connector",
    summary: "Use the user's assigned Gmail account through scoped OAuth state.",
    enabledByDefault: true,
    scopes: ["own_connectors"],
    requiresConnector: "gmail",
  },
  {
    id: "outlook",
    label: "Outlook",
    category: "connector",
    summary: "Use the user's assigned Outlook account through scoped OAuth state.",
    enabledByDefault: true,
    scopes: ["own_connectors"],
    requiresConnector: "outlook",
  },
  {
    id: "linkedin",
    label: "Managed Desktop",
    category: "desktop",
    summary: "Use the user's assigned managed browser desktop for web workflows.",
    enabledByDefault: true,
    scopes: ["own_desktop"],
    requiresDesktop: "linkedin",
  },
  {
    id: "learning",
    label: "Learning Skills",
    category: "learning",
    summary: "Track user-specific learning skills and guidance inside the tenant boundary.",
    enabledByDefault: true,
    scopes: ["own_workspace"],
  },
];

const FIELD_LIMITS = {
  name: 120,
  description: 2000,
  instructions: 8000,
  metadataString: 1000,
};

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function skillError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function bounded(value = "", max = 1000) {
  return clean(value).slice(0, max);
}

export function normalizeSkillId(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function builtinUserSkillDefinitions() {
  return skillDefinitions.map((definition) => ({
    ...definition,
    scopes: [...definition.scopes],
  }));
}

function definitionForSkill(skillId) {
  const id = normalizeSkillId(skillId);
  return skillDefinitions.find((definition) => definition.id === id) || null;
}

function safeMetadata(input = {}, depth = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input) || depth > 3) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, 50)) {
    const key = bounded(rawKey, 80);
    if (!key) continue;
    if (/(token|secret|password|credential|cookie|session|bearer|api[_-]?key|private[_-]?key)/i.test(key)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      output[key] = rawValue.slice(0, 20).map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) return safeMetadata(item, depth + 1);
        if (typeof item === "number" || typeof item === "boolean") return item;
        return bounded(item, FIELD_LIMITS.metadataString);
      });
      continue;
    }
    if (rawValue && typeof rawValue === "object") {
      output[key] = safeMetadata(rawValue, depth + 1);
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      output[key] = rawValue;
      continue;
    }
    output[key] = bounded(rawValue, FIELD_LIMITS.metadataString);
  }
  return output;
}

function normalizeScopes(input, fallback = []) {
  const source = Array.isArray(input) && input.length ? input : fallback;
  return [...new Set(source.map((scope) => bounded(scope, 80)).filter(Boolean))].slice(0, 20);
}

function normalizeSkillRecord(skillId, input = {}, existing = null, definition = null, options = {}) {
  const id = normalizeSkillId(skillId || input.id || input.skillId);
  if (!id) throw skillError("skill_id_required", 400);
  const builtIn = Boolean(definition);
  const createdAt = clean(input.createdAt) || clean(existing?.createdAt) || (options.touch === false ? "" : nowIso());
  const updatedAt = options.touch === false
    ? clean(input.updatedAt || existing?.updatedAt)
    : nowIso();
  const fallbackName = definition?.label || id;
  const fallbackDescription = definition?.summary || "";
  const enabledFallback = existing?.enabled !== undefined
    ? existing.enabled === true
    : definition?.enabledByDefault !== false;
  return {
    id,
    name: bounded(definition?.label || input.name || input.label || existing?.name || existing?.label || fallbackName, FIELD_LIMITS.name) || fallbackName,
    label: bounded(definition?.label || input.label || input.name || existing?.label || existing?.name || fallbackName, FIELD_LIMITS.name) || fallbackName,
    description: bounded(definition?.summary || input.description || input.summary || existing?.description || existing?.summary || fallbackDescription, FIELD_LIMITS.description),
    summary: bounded(definition?.summary || input.summary || input.description || existing?.summary || existing?.description || fallbackDescription, FIELD_LIMITS.description),
    instructions: bounded(input.instructions || existing?.instructions || "", FIELD_LIMITS.instructions),
    category: bounded(definition?.category || input.category || existing?.category || "user", 80),
    enabled: boolValue(input.enabled, enabledFallback),
    enabledByDefault: definition ? definition.enabledByDefault !== false : boolValue(input.enabledByDefault, true),
    builtIn,
    createdBy: bounded(input.createdBy || existing?.createdBy || (builtIn ? "system" : "api"), 80),
    scopes: normalizeScopes(input.scopes || existing?.scopes, definition?.scopes || []),
    requiresConnector: bounded(definition?.requiresConnector || input.requiresConnector || existing?.requiresConnector || "", 80),
    requiresDesktop: bounded(definition?.requiresDesktop || input.requiresDesktop || existing?.requiresDesktop || "", 80),
    metadata: safeMetadata(input.metadata || existing?.metadata || {}),
    createdAt,
    updatedAt,
    deletedAt: clean(input.deletedAt || existing?.deletedAt),
  };
}

async function readUserSkillFile(userId, env = process.env) {
  const file = userDataPaths(userId, env).skills;
  const payload = await readJson(file, { schemaVersion: 1, skills: {} });
  const skills = payload && typeof payload === "object" && !Array.isArray(payload) && payload.skills && typeof payload.skills === "object"
    ? payload.skills
    : {};
  return { schemaVersion: 1, skills };
}

async function writeUserSkillFile(userId, payload, env = process.env) {
  await writeJson(userDataPaths(userId, env).skills, {
    schemaVersion: 1,
    userId: normalizeUserId(userId),
    skills: payload.skills || {},
    updatedAt: nowIso(),
  });
}

async function assertKnownUser(userId, env = process.env) {
  const user = await getUser(userId, env);
  if (!user) throw skillError("user_not_found", 404);
  return user;
}

function storedSkillRecords(payload = {}) {
  const rawSkills = payload.skills && typeof payload.skills === "object" ? payload.skills : {};
  const records = [];
  for (const definition of builtinUserSkillDefinitions()) {
    records.push(normalizeSkillRecord(definition.id, rawSkills[definition.id] || {}, null, definition, { touch: false }));
  }
  for (const [rawId, rawRecord] of Object.entries(rawSkills)) {
    const id = normalizeSkillId(rawId);
    if (!id || definitionForSkill(id)) continue;
    const record = normalizeSkillRecord(id, rawRecord && typeof rawRecord === "object" ? rawRecord : { id }, null, null, { touch: false });
    if (!record.deletedAt) records.push(record);
  }
  return records;
}

function publicSkill(record = {}) {
  return {
    id: record.id,
    name: record.name || record.label || record.id,
    label: record.label || record.name || record.id,
    description: clean(record.description || record.summary),
    summary: clean(record.summary || record.description),
    instructions: clean(record.instructions),
    category: clean(record.category || "user"),
    enabled: record.enabled === true,
    enabledByDefault: record.enabledByDefault !== false,
    builtIn: record.builtIn === true,
    createdBy: clean(record.createdBy || (record.builtIn ? "system" : "api")),
    scopes: Array.isArray(record.scopes) ? [...record.scopes] : [],
    requiresConnector: clean(record.requiresConnector),
    requiresDesktop: clean(record.requiresDesktop),
    metadata: safeMetadata(record.metadata || {}),
    createdAt: clean(record.createdAt),
    updatedAt: clean(record.updatedAt),
  };
}

export async function listUserSkills(userId, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const payload = await readUserSkillFile(user.id, env);
  return {
    userId: user.id,
    skills: storedSkillRecords(payload).map((record) => publicSkill(record)),
    generatedAt: nowIso(),
  };
}

export async function listUserSkillsForPrincipal(userId, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_access", env);
  return listUserSkills(target.id, env);
}

export async function getUserSkill(userId, skillId, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const id = normalizeSkillId(skillId);
  const skill = (await listUserSkills(user.id, env)).skills.find((item) => item.id === id);
  if (!skill) throw skillError("skill_not_found", 404);
  return { ok: true, userId: user.id, skill };
}

export async function getUserSkillForPrincipal(userId, skillId, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_access", env);
  return getUserSkill(target.id, skillId, env);
}

export async function createUserSkill(userId, input = {}, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const id = normalizeSkillId(input.id || input.skillId || input.name || input.label);
  if (!id) throw skillError("skill_id_required", 400);
  if (definitionForSkill(id)) throw skillError("skill_reserved", 409);
  const payload = await readUserSkillFile(user.id, env);
  const existing = payload.skills[id];
  if (existing && !clean(existing.deletedAt)) throw skillError("skill_exists", 409);
  const record = normalizeSkillRecord(id, { ...input, id, enabled: input.enabled ?? true }, existing, null, { touch: true });
  const next = {
    ...payload,
    skills: {
      ...payload.skills,
      [id]: record,
    },
  };
  await writeUserSkillFile(user.id, next, env);
  await appendEvent({
    type: "user_skill_created",
    userId: user.id,
    skillId: id,
    enabled: record.enabled,
  }, env).catch(() => {});
  return {
    ok: true,
    userId: user.id,
    skill: publicSkill(record),
  };
}

export async function createUserSkillForPrincipal(userId, input = {}, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_create", env);
  return createUserSkill(target.id, { ...input, createdBy: input.createdBy || "api" }, env);
}

export async function updateUserSkill(userId, skillId, patch = {}, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const id = normalizeSkillId(skillId || patch.id || patch.skillId);
  if (!id) throw skillError("skill_id_required", 400);
  const definition = definitionForSkill(id);
  const payload = await readUserSkillFile(user.id, env);
  const existing = payload.skills[id] || null;
  if (!definition && (!existing || clean(existing.deletedAt))) throw skillError("skill_not_found", 404);
  const record = normalizeSkillRecord(id, { ...existing, ...patch, id }, existing, definition, { touch: true });
  const next = {
    ...payload,
    skills: {
      ...payload.skills,
      [id]: record,
    },
  };
  await writeUserSkillFile(user.id, next, env);
  await appendEvent({
    type: "user_skill_updated",
    userId: user.id,
    skillId: id,
    enabled: record.enabled,
  }, env).catch(() => {});
  return {
    ok: true,
    userId: user.id,
    skill: publicSkill(record),
  };
}

export async function setUserSkill(userId, skillId, patch = {}, env = process.env) {
  return updateUserSkill(userId, skillId, patch, env);
}

export async function setUserSkillForPrincipal(userId, skillId, patch = {}, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_update", env);
  if (!isAdminPrincipal(principal) && patch.enabled === undefined && !patch.name && !patch.description && !patch.instructions && !patch.metadata) {
    throw skillError("skill_patch_required", 400);
  }
  return updateUserSkill(target.id, skillId, patch, env);
}

export async function deleteUserSkill(userId, skillId, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const id = normalizeSkillId(skillId);
  if (!id) throw skillError("skill_id_required", 400);
  const definition = definitionForSkill(id);
  const payload = await readUserSkillFile(user.id, env);
  const existing = payload.skills[id] || null;
  if (!definition && (!existing || clean(existing.deletedAt))) throw skillError("skill_not_found", 404);
  const record = definition
    ? normalizeSkillRecord(id, { ...existing, enabled: false }, existing, definition, { touch: true })
    : normalizeSkillRecord(id, { ...existing, enabled: false, deletedAt: nowIso() }, existing, null, { touch: true });
  await writeUserSkillFile(user.id, {
    ...payload,
    skills: {
      ...payload.skills,
      [id]: record,
    },
  }, env);
  await appendEvent({
    type: definition ? "user_skill_disabled" : "user_skill_deleted",
    userId: user.id,
    skillId: id,
  }, env).catch(() => {});
  return {
    ok: true,
    userId: user.id,
    skillId: id,
    deleted: !definition,
    disabled: definition ? true : undefined,
  };
}

export async function deleteUserSkillForPrincipal(userId, skillId, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_delete", env);
  return deleteUserSkill(target.id, skillId, env);
}

export async function searchUserSkills(userId, query = "", env = process.env) {
  const user = await assertKnownUser(userId, env);
  const needle = clean(query).toLowerCase();
  const listed = await listUserSkills(user.id, env);
  const skills = needle
    ? listed.skills.filter((skill) => [
        skill.id,
        skill.name,
        skill.label,
        skill.description,
        skill.summary,
        skill.instructions,
      ].some((value) => clean(value).toLowerCase().includes(needle)))
    : listed.skills;
  return {
    userId: user.id,
    query: needle,
    skills,
    generatedAt: nowIso(),
  };
}

export async function searchUserSkillsForPrincipal(userId, query = "", principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_access", env);
  return searchUserSkills(target.id, query, env);
}

function defaultSkillSnapshot(userId) {
  const skills = builtinUserSkillDefinitions().map((definition) => publicSkill(normalizeSkillRecord(definition.id, {}, null, definition, { touch: false })));
  const skillEnabled = Object.fromEntries(skills.map((skill) => [skill.id, skill.enabled === true]));
  return {
    userId: normalizeUserId(userId),
    source: "user-skill-defaults",
    userFound: false,
    skills,
    skillEnabled,
    enabledSkills: skills.filter((skill) => skill.enabled).map((skill) => skill.id),
    disabledSkills: skills.filter((skill) => !skill.enabled).map((skill) => skill.id),
  };
}

export async function userSkillCapabilitySnapshot(userId, env = process.env) {
  const id = normalizeUserId(userId);
  try {
    const listed = await listUserSkills(id, env);
    const skillEnabled = Object.fromEntries(listed.skills.map((skill) => [skill.id, skill.enabled === true]));
    return {
      userId: listed.userId,
      source: "user-skill-registry",
      userFound: true,
      skills: listed.skills,
      skillEnabled,
      enabledSkills: listed.skills.filter((skill) => skill.enabled).map((skill) => skill.id),
      disabledSkills: listed.skills.filter((skill) => !skill.enabled).map((skill) => skill.id),
    };
  } catch (error) {
    if (error?.statusCode !== 404 && error?.message !== "user_not_found") throw error;
    return defaultSkillSnapshot(id);
  }
}

function threadHasWhatsAppBinding(thread = {}) {
  return Boolean(thread?.binding?.connector === "whatsapp" || thread?.binding?.chatId || thread?.binding?.waChatId);
}

function tenantCapabilitySet(tenantVm = null) {
  return new Set(Array.isArray(tenantVm?.capabilities) ? tenantVm.capabilities.map((item) => clean(item).toLowerCase()).filter(Boolean) : []);
}

function tenantConnectorState(tenantVm = null) {
  const capabilities = tenantCapabilitySet(tenantVm);
  const connectors = tenantVm?.connectors && typeof tenantVm.connectors === "object" ? tenantVm.connectors : {};
  return {
    whatsapp: Boolean(
      capabilities.has("whatsapp") ||
      connectors.whatsappRouteEnabled === true ||
      clean(connectors.whatsappChatId) ||
      clean(connectors.whatsappChatName) ||
      clean(connectors.whatsappAccountId)
    ),
    gmail: Boolean(capabilities.has("gmail") || clean(connectors.gmailAccountId)),
    outlook: Boolean(capabilities.has("outlook") || clean(connectors.outlookAccountId)),
    linkedin: Boolean(capabilities.has("desks") || capabilities.has("linkedin") || clean(connectors.linkedinDesktopSlug)),
  };
}

function configuredVisibleDesktopSlugs(env = process.env) {
  const raw = clean(env.ORKESTR_BROWSER_VISIBLE_SLUGS || env.ORKESTR_OPS_DESKTOP_SLUGS);
  if (!raw) return null;
  const slugs = raw.split(/[\s,]+/g).map((slug) => clean(slug)).filter(Boolean);
  return slugs.length ? new Set(slugs) : null;
}

function userDesktopSkillAvailable(skillId = "", snapshot = {}, env = process.env) {
  if (snapshot.userFound !== true) return false;
  const enabled = clean(env.ORKESTR_USER_DESKTOPS_ENABLED).toLowerCase();
  if (["0", "false", "no"].includes(enabled)) return false;
  const visible = configuredVisibleDesktopSlugs(env);
  if (!visible) return true;
  if (skillId === "linkedin") return visible.has("linkedin");
  return visible.has(skillId);
}

function publicSkillList(skills = []) {
  return skills.map((skill) => ({
    id: skill.id,
    name: clean(skill.name || skill.label || skill.id),
    label: skill.label,
    description: clean(skill.description || skill.summary),
    summary: clean(skill.summary || skill.description),
    instructions: clean(skill.instructions),
    category: skill.category,
    enabled: skill.enabled === true,
    builtIn: skill.builtIn === true,
    createdBy: clean(skill.createdBy || (skill.builtIn ? "system" : "api")),
    scopes: Array.isArray(skill.scopes) ? [...skill.scopes] : [],
    requiresConnector: clean(skill.requiresConnector),
    requiresDesktop: clean(skill.requiresDesktop),
    metadata: safeMetadata(skill.metadata || {}),
  }));
}

export async function userScopedCapabilityHints({ userId = "", thread = null } = {}, env = process.env) {
  const owner = normalizeUserId(userId || thread?.ownerUserId || thread?.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const snapshot = await userSkillCapabilitySnapshot(owner, env);
  const tenantVm = await getTenantVmForOwner(owner, env).catch(() => null);
  const tenantConnectors = tenantConnectorState(tenantVm);
  const hasThreadWhatsAppBinding = threadHasWhatsAppBinding(thread || {});
  const scopedConnectors = {
    ...tenantConnectors,
    whatsapp: tenantConnectors.whatsapp || hasThreadWhatsAppBinding,
  };
  const enabled = (skillId) => snapshot.skillEnabled[skillId] === true;
  const whatsappAvailable = scopedConnectors.whatsapp;
  const linkedinAvailable = scopedConnectors.linkedin || userDesktopSkillAvailable("linkedin", snapshot, env);

  return {
    threads: true,
    whereiam: enabled("whereiam"),
    files: enabled("files"),
    timers: enabled("timers"),
    virtualBrowsers: enabled("linkedin") && linkedinAvailable,
    desktopLeases: enabled("linkedin") && linkedinAvailable,
    whatsapp: enabled("whatsapp") && whatsappAvailable,
    gmail: enabled("gmail") && scopedConnectors.gmail,
    outlook: enabled("outlook") && scopedConnectors.outlook,
    linkedin: enabled("linkedin") && linkedinAvailable,
    learning: enabled("learning"),
    hostSkills: false,
    globalConnectorAccounts: false,
    privateOperatorData: false,
    skillRegistry: {
      userId: snapshot.userId,
      source: snapshot.source,
      userFound: snapshot.userFound,
    },
    enabledSkills: [...snapshot.enabledSkills],
    disabledSkills: [...snapshot.disabledSkills],
    skills: publicSkillList(snapshot.skills),
    scopedConnectors,
  };
}
