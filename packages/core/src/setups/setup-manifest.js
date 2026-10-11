// Setup manifest contract, schema "orkestr.setup/v1".
//
// A Setup is a ready-made automation (for example a fitness tracker) that an
// owner installs into their own Orkestr. The manifest declares everything the
// installer may create and everything the Setup needs before it can work, so
// install, status and uninstall stay predictable. See docs/setups/manifest-v1.md.

export const SETUP_MANIFEST_SCHEMA = "orkestr.setup/v1";

export const SETUP_PROVIDERS = ["codex", "claude-code"];
export const SETUP_CHANNELS = ["whatsapp", "web"];
export const SETUP_TIMER_CADENCES = ["daily", "weekly"];

// Every resource or capability a Setup can touch must be one of these. The
// installer refuses manifests that ask for anything else.
export const SETUP_PERMISSIONS = {
  "thread.create": "Create one conversation thread owned by you.",
  "thread.mission.set": "Store the Setup's standing instructions on that thread.",
  "timer.create": "Create the scheduled check-ins listed in the manifest, targeting that thread only.",
  "state.write": "Keep the Setup's own records (for example logged workouts) under your Orkestr home.",
  "whatsapp.reply-owner": "Reply in one WhatsApp chat you bind yourself, to you only. Never granted by install.",
};

const ID = /^[a-z][a-z0-9-]{1,47}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(problems, path, message) {
  problems.push(`${path}: ${message}`);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateRequires(requires, problems) {
  if (!requires || typeof requires !== "object") return fail(problems, "requires", "required object");
  const anyOf = requires.providers?.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length === 0) fail(problems, "requires.providers.anyOf", "list at least one provider");
  else for (const provider of anyOf) if (!SETUP_PROVIDERS.includes(provider)) fail(problems, "requires.providers.anyOf", `unknown provider ${provider}`);
  for (const [index, channel] of (requires.channels || []).entries()) {
    if (!SETUP_CHANNELS.includes(channel?.id)) fail(problems, `requires.channels[${index}].id`, "unknown channel");
    if (typeof channel?.required !== "boolean") fail(problems, `requires.channels[${index}].required`, "must be true or false");
    if (!text(channel?.purpose)) fail(problems, `requires.channels[${index}].purpose`, "explain why the channel is needed");
  }
  const platform = requires.platform;
  if (!platform || typeof platform.alwaysOn !== "boolean") fail(problems, "requires.platform.alwaysOn", "must say whether the host must stay on");
}

function validatePermissions(manifest, problems) {
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) return fail(problems, "permissions", "list the permissions the Setup needs");
  const ids = new Set();
  for (const [index, permission] of permissions.entries()) {
    if (!(permission?.id in SETUP_PERMISSIONS)) fail(problems, `permissions[${index}].id`, `unknown permission ${permission?.id}`);
    if (ids.has(permission?.id)) fail(problems, `permissions[${index}].id`, "duplicate");
    ids.add(permission?.id);
  }
  // Least privilege: each created resource needs its permission, and nothing
  // may be requested that the manifest does not use.
  const needed = new Set(["thread.create"]);
  if (text(manifest.thread?.mission)) needed.add("thread.mission.set");
  if ((manifest.timers || []).length) needed.add("timer.create");
  if (manifest.state) needed.add("state.write");
  if ((manifest.requires?.channels || []).some((channel) => channel?.id === "whatsapp")) needed.add("whatsapp.reply-owner");
  for (const id of needed) if (!ids.has(id)) fail(problems, "permissions", `missing ${id}`);
  for (const id of ids) if (!needed.has(id)) fail(problems, "permissions", `${id} is requested but not used`);
  const whatsapp = permissions.find((permission) => permission?.id === "whatsapp.reply-owner");
  if (whatsapp && whatsapp.grantedByInstall !== false) fail(problems, "permissions.whatsapp.reply-owner", "must set grantedByInstall: false");
}

function validateTimers(timers, problems) {
  if (!Array.isArray(timers)) return fail(problems, "timers", "must be a list");
  const keys = new Set();
  for (const [index, timer] of timers.entries()) {
    const at = `timers[${index}]`;
    if (!ID.test(timer?.key || "")) fail(problems, `${at}.key`, "lowercase id");
    if (keys.has(timer?.key)) fail(problems, `${at}.key`, "duplicate");
    keys.add(timer?.key);
    if (!text(timer?.label)) fail(problems, `${at}.label`, "required");
    if (!SETUP_TIMER_CADENCES.includes(timer?.cadence)) fail(problems, `${at}.cadence`, "daily or weekly");
    if (!CLOCK.test(timer?.time || "")) fail(problems, `${at}.time`, "HH:MM");
    if (!text(timer?.prompt)) fail(problems, `${at}.prompt`, "required");
  }
}

function validateState(state, problems) {
  if (state === undefined) return;
  if (state?.store !== "setup-events") fail(problems, "state.store", "only setup-events is supported");
  if (!Number.isInteger(state?.schemaVersion) || state.schemaVersion < 1) fail(problems, "state.schemaVersion", "positive integer");
  const migrations = state?.migrations || [];
  if (!Array.isArray(migrations)) fail(problems, "state.migrations", "must be a list");
  else for (const [index, migration] of migrations.entries()) {
    if (!(Number.isInteger(migration?.from) && migration.to === migration.from + 1)) fail(problems, `state.migrations[${index}]`, "steps go from N to N+1");
  }
  if (!["retain", "delete"].includes(state?.onUninstall)) fail(problems, "state.onUninstall", "retain or delete");
}

export function validateSetupManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return { ok: false, problems: ["manifest: required object"] };
  if (manifest.schema !== SETUP_MANIFEST_SCHEMA) fail(problems, "schema", `must be ${SETUP_MANIFEST_SCHEMA}`);
  if (!ID.test(manifest.id || "")) fail(problems, "id", "lowercase id");
  if (!SEMVER.test(manifest.version || "")) fail(problems, "version", "MAJOR.MINOR.PATCH");
  if (!text(manifest.title)) fail(problems, "title", "required");
  if (!text(manifest.summary)) fail(problems, "summary", "required");
  if (!["preview", "stable"].includes(manifest.status)) fail(problems, "status", "preview or stable");
  validateRequires(manifest.requires, problems);
  if (!text(manifest.thread?.name)) fail(problems, "thread.name", "required");
  validatePermissions(manifest, problems);
  validateTimers(manifest.timers || [], problems);
  validateState(manifest.state, problems);
  if (!["retire"].includes(manifest.uninstall?.thread)) fail(problems, "uninstall.thread", "only retire is supported, so conversations stay restorable");
  return { ok: problems.length === 0, problems };
}

export function assertValidSetupManifest(manifest) {
  const result = validateSetupManifest(manifest);
  if (!result.ok) {
    const error = new Error(`setup_manifest_invalid: ${result.problems.join("; ")}`);
    error.code = "setup_manifest_invalid";
    error.problems = result.problems;
    throw error;
  }
  return manifest;
}
