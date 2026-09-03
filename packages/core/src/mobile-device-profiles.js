import path from "node:path";
import { readJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

const defaultScopes = ["threads:read", "threads:write", "desktops:open"];

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
  return [...new Set(raw.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))].slice(0, 80);
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
  const role = String(input.role || "").trim().toLowerCase() === "admin" ? "admin" : "user";
  return {
    id,
    label: String(input.label || input.name || id).trim().slice(0, 120),
    userId: normalizeUserId(input.userId || input.ownerUserId || input.email || id),
    role,
    scopes: splitScopes(input.scopes || defaultScopes),
    enabled: input.enabled !== false,
  };
}

function profileListFromPayload(payload = {}) {
  const raw = Array.isArray(payload) ? payload : payload.profiles || payload.mobileProfiles || [];
  return Array.isArray(raw) ? raw.map(normalizeProfile).filter(Boolean) : [];
}

export async function listMobileProfiles({ env = process.env } = {}) {
  const filePath = profileSourcePath(env);
  if (!filePath) return { profiles: [], source: "unconfigured" };
  const payload = await readJson(filePath, null).catch(() => null);
  const profiles = profileListFromPayload(payload).filter((profile) => profile.enabled);
  return {
    profiles: profiles.map((profile) => ({ ...profile })),
    source: "overlay",
  };
}

export async function getMobileProfile(profileId = "", { env = process.env } = {}) {
  const id = cleanId(profileId);
  if (!id) return null;
  return (await listMobileProfiles({ env })).profiles.find((profile) => profile.id === id) || null;
}
