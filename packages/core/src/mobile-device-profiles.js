import path from "node:path";
import { readJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

const allowedScopes = new Set(["thread:input", "thread:read"]);
const defaultScopes = ["thread:input", "thread:read"];

function cleanId(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function splitScopes(value = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/g);
  return [...new Set(raw.map((item) => String(item || "").trim().toLowerCase()).filter((item) => allowedScopes.has(item)))].slice(0, 20);
}

function profileSourcePath(env = process.env) {
  const explicit = String(env.ORKESTR_MOBILE_PROFILES_FILE || "").trim();
  if (explicit) return explicit;
  const overlayDir = String(env.ORKESTR_OVERLAY_DIR || "").trim();
  return overlayDir ? path.join(overlayDir, "mobile-profiles.json") : "";
}

function normalizeProfile(input = {}) {
  const id = cleanId(input.id || input.profileId || input.slug || input.name);
  if (!id) return null;
  const ownerUserIdRaw = String(input.ownerUserId || "").trim();
  const userIdRaw = String(input.userId || "").trim();
  const threadId = cleanId(input.threadId || input.thread || input.hushThreadId);
  if (!ownerUserIdRaw || !userIdRaw || !threadId) return null;
  const role = String(input.role || "").trim().toLowerCase() === "admin" ? "admin" : "user";
  return {
    id,
    label: String(input.label || input.name || id).trim().slice(0, 120),
    ownerUserId: normalizeUserId(ownerUserIdRaw),
    userId: normalizeUserId(userIdRaw),
    threadId,
    role,
    scopes: splitScopes(input.scopes || defaultScopes),
    enabled: input.enabled !== false,
  };
}

function profileListFromPayload(payload = {}) {
  const raw = Array.isArray(payload) ? payload : payload.profiles || payload.mobileProfiles || [];
  return Array.isArray(raw) ? raw.map(normalizeProfile).filter(Boolean) : [];
}

function principalOwnerId(principal = null) {
  const raw = String(principal?.userId || "").trim();
  return raw ? normalizeUserId(raw) : "";
}

function publicProfile(profile = {}) {
  return {
    id: profile.id || "",
    label: profile.label || profile.id || "",
    status: profile.enabled === false ? "disabled" : "active",
  };
}

export async function readMobileProfileRecords({ env = process.env } = {}) {
  const filePath = profileSourcePath(env);
  if (!filePath) return { profiles: [], source: "unconfigured" };
  const payload = await readJson(filePath, null).catch(() => null);
  const profiles = profileListFromPayload(payload).filter((profile) => profile.enabled);
  return {
    profiles: profiles.map((profile) => ({ ...profile })),
    source: "overlay",
  };
}

export async function listMobileProfiles({ env = process.env, principal = null } = {}) {
  const ownerUserId = principalOwnerId(principal);
  const records = await readMobileProfileRecords({ env });
  const profiles = ownerUserId
    ? records.profiles.filter((profile) => profile.ownerUserId === ownerUserId)
    : records.profiles;
  return { profiles: profiles.map(publicProfile) };
}

export async function getMobileProfile(profileId = "", { env = process.env, principal = null } = {}) {
  const id = cleanId(profileId);
  if (!id) return null;
  const ownerUserId = principalOwnerId(principal);
  const profile = (await readMobileProfileRecords({ env })).profiles.find((item) => item.id === id) || null;
  if (!profile) return null;
  if (ownerUserId && profile.ownerUserId !== ownerUserId) return null;
  return { ...profile };
}
