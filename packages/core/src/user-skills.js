import { userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, isAdminPrincipal } from "./policy.js";
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
    label: "LinkedIn Desk",
    category: "desktop",
    summary: "Use the user's assigned desktop for LinkedIn and browser-based workflows.",
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

function normalizeOverride(skillId, input = {}) {
  const id = normalizeSkillId(skillId || input.id || input.skillId);
  if (!id) throw skillError("skill_id_required", 400);
  const enabled = input.enabled === undefined ? true : input.enabled === true || input.enabled === "true" || input.enabled === 1;
  return {
    id,
    enabled,
    updatedAt: clean(input.updatedAt) || nowIso(),
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

function publicSkill(definition, override = null) {
  const enabled = override?.enabled === undefined ? definition.enabledByDefault !== false : override.enabled === true;
  return {
    id: definition.id,
    label: definition.label,
    category: definition.category,
    summary: definition.summary,
    enabled,
    enabledByDefault: definition.enabledByDefault !== false,
    scopes: [...definition.scopes],
    requiresConnector: definition.requiresConnector || "",
    requiresDesktop: definition.requiresDesktop || "",
    updatedAt: clean(override?.updatedAt),
  };
}

export async function listUserSkills(userId, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const payload = await readUserSkillFile(user.id, env);
  return {
    userId: user.id,
    skills: builtinUserSkillDefinitions().map((definition) => publicSkill(definition, payload.skills[definition.id] || null)),
    generatedAt: nowIso(),
  };
}

export async function listUserSkillsForPrincipal(userId, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_access", env);
  return listUserSkills(target.id, env);
}

export async function setUserSkill(userId, skillId, patch = {}, env = process.env) {
  const user = await assertKnownUser(userId, env);
  const definition = definitionForSkill(skillId);
  if (!definition) throw skillError("skill_not_found", 404);
  const payload = await readUserSkillFile(user.id, env);
  const override = normalizeOverride(definition.id, { ...patch, id: definition.id });
  const next = {
    ...payload,
    skills: {
      ...payload.skills,
      [definition.id]: override,
    },
  };
  await writeUserSkillFile(user.id, next, env);
  await appendEvent({
    type: "user_skill_updated",
    userId: user.id,
    skillId: definition.id,
    enabled: override.enabled,
  }, env).catch(() => {});
  return {
    ok: true,
    userId: user.id,
    skill: publicSkill(definition, override),
  };
}

export async function setUserSkillForPrincipal(userId, skillId, patch = {}, principal = {}, env = process.env) {
  const target = await assertKnownUser(userId, env);
  assertOwnerAccess(principal, target.id, "user_skills_update", env);
  if (!isAdminPrincipal(principal) && patch.enabled === undefined) throw skillError("skill_enabled_required", 400);
  return setUserSkill(target.id, skillId, patch, env);
}
