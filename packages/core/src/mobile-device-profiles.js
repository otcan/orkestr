import path from "node:path";
import { readJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

function cleanId(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function cleanThreadId(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function profileSourcePath(env = process.env) {
  const explicit = String(env.ORKESTR_MOBILE_PROFILES_FILE || "").trim();
  if (explicit) return explicit;
  const overlayDir = String(env.ORKESTR_OVERLAY_DIR || "").trim();
  return overlayDir ? path.join(overlayDir, "mobile-profiles.json") : "";
}

function normalizeProfile(input = {}) {
  const id = cleanId(input.id || input.profileId || input.slug || input.name);
  const rawOwnerUserId = String(input.ownerUserId || input.userId || "").trim();
  const ownerUserId = rawOwnerUserId ? normalizeUserId(rawOwnerUserId) : "";
  const threadId = cleanThreadId(input.threadId);
  if (!id || !ownerUserId || !threadId) return null;
  return {
    id,
    label: String(input.label || input.name || id).trim().slice(0, 120),
    ownerUserId,
    threadId,
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
