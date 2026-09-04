import path from "node:path";
import { readJson } from "../../storage/src/store.js";
import { resolveSecureSecretValue } from "./secure-secrets.js";
import { adminUserId, normalizeUserId } from "./users.js";

const defaultProfilesSecretName = "hush-mobile-profiles";

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
  const value = payload && typeof payload === "object" ? payload : {};
  const raw = Array.isArray(value) ? value : value.profiles || value.mobileProfiles || [];
  return Array.isArray(raw) ? raw.map(normalizeProfile).filter(Boolean) : [];
}

function parseSecretPayload(value = "") {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function listMobileProfiles({ env = process.env } = {}) {
  const filePath = profileSourcePath(env);
  let payload = filePath ? await readJson(filePath, null).catch(() => null) : null;
  let source = payload ? "overlay" : "unconfigured";
  if (!payload) {
    const secretName = String(env.ORKESTR_MOBILE_PROFILES_SECRET || defaultProfilesSecretName).trim();
    const resolved = secretName
      ? await resolveSecureSecretValue(secretName, {
          ownerUserId: normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId),
          usedBy: "hush-mobile-profiles",
        }, env).catch(() => null)
      : null;
    if (resolved?.value) {
      payload = parseSecretPayload(resolved.value);
      source = payload ? "secure-input" : "secure-input-invalid";
    }
  }
  const profiles = profileListFromPayload(payload).filter((profile) => profile.enabled);
  return {
    profiles: profiles.map((profile) => ({ ...profile })),
    source,
  };
}

export async function getMobileProfile(profileId = "", { env = process.env } = {}) {
  const id = cleanId(profileId);
  if (!id) return null;
  return (await listMobileProfiles({ env })).profiles.find((profile) => profile.id === id) || null;
}
