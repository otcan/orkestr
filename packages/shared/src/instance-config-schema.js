const TOP_LEVEL_SECTIONS = ["metadata", "runtime", "capabilities", "connectors", "desktops", "mailboxes"];
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "generation", "createdAt", "updatedAt", ...TOP_LEVEL_SECTIONS]);
const SECRET_FIELD = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token|cookie|keyring|oauth[_-]?state|qr)(?:$|[_-])/i;
const COMPACT_SECRET_FIELD = /(?:apikey|accesstoken|refreshtoken|clientsecret|privatekey|password|passwd|secret|cookie|keyring|oauthstate|qrcode)/;

export function instanceConfigFieldIsSecret(value = "") {
  const field = String(value || "");
  const compact = field.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_FIELD.test(field) || COMPACT_SECRET_FIELD.test(compact) || compact === "token" || compact === "qr";
}

function configError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { statusCode, code, details });
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertJsonValue(value, pointer = "") {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${pointer}/${index}`));
    return;
  }
  if (!plainObject(value)) throw configError("instance_config_json_value_required", 400, { pointer });
  for (const [key, entry] of Object.entries(value)) {
    const childPointer = `${pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (instanceConfigFieldIsSecret(key)) throw configError("instance_config_secret_field_forbidden", 400, { pointer: childPointer });
    assertJsonValue(entry, childPointer);
  }
}

function deploymentFieldError(pointer) {
  throw configError("instance_config_deployment_field_forbidden", 400, { pointer });
}

function assertDeploymentBoundaries(value = {}) {
  if (plainObject(value.runtime?.codex) && Object.hasOwn(value.runtime.codex, "command")) {
    deploymentFieldError("/runtime/codex/command");
  }
  if (plainObject(value.connectors) && Object.hasOwn(value.connectors, "mcp")) {
    deploymentFieldError("/connectors/mcp");
  }
  const walkDesktop = (entry, pointer) => {
    if (!plainObject(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const childPointer = `${pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (["url", "cdpurl", "workspacepath", "profiledir", "profilepath", "endpoint"].includes(compact)) {
        deploymentFieldError(childPointer);
      }
      if (plainObject(child)) walkDesktop(child, childPointer);
      else if (Array.isArray(child)) child.forEach((item, index) => walkDesktop(item, `${childPointer}/${index}`));
    }
  };
  walkDesktop(value.desktops, "/desktops");
}

export function emptyInstanceConfig(now = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    runtime: {},
    capabilities: {},
    connectors: {},
    desktops: {},
    mailboxes: {},
  };
}

export function validateInstanceConfig(value, { allowGeneration = true } = {}) {
  if (!plainObject(value)) throw configError("instance_config_object_required");
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length) throw configError("instance_config_unknown_top_level_field", 400, { fields: unknown });
  if (value.schemaVersion !== undefined && Number(value.schemaVersion) !== 1) {
    throw configError("instance_config_schema_version_unsupported");
  }
  if (allowGeneration && value.generation !== undefined && (!Number.isInteger(value.generation) || value.generation < 0)) {
    throw configError("instance_config_generation_invalid");
  }
  for (const section of TOP_LEVEL_SECTIONS) {
    if (value[section] !== undefined && !plainObject(value[section])) {
      throw configError("instance_config_section_object_required", 400, { section });
    }
    assertJsonValue(value[section] || {}, `/${section}`);
  }
  assertDeploymentBoundaries(value);
  return value;
}

export function normalizeInstanceConfig(value = {}, now = new Date().toISOString()) {
  validateInstanceConfig(value);
  const defaults = emptyInstanceConfig(now);
  return {
    ...defaults,
    ...clone(value),
    schemaVersion: 1,
    generation: Number.isInteger(value.generation) ? value.generation : 0,
    createdAt: String(value.createdAt || defaults.createdAt),
    updatedAt: String(value.updatedAt || value.createdAt || defaults.updatedAt),
    ...Object.fromEntries(TOP_LEVEL_SECTIONS.map((section) => [section, clone(value[section] || {})])),
  };
}

function mergePatchValue(current, patch) {
  if (!plainObject(patch)) return clone(patch);
  const next = plainObject(current) ? clone(current) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = mergePatchValue(next[key], value);
  }
  return next;
}

export function applyInstanceConfigPatch(current, patch = {}) {
  if (!plainObject(patch)) throw configError("instance_config_patch_object_required");
  const immutable = ["schemaVersion", "generation", "createdAt", "updatedAt"].filter((key) => key in patch);
  if (immutable.length) throw configError("instance_config_managed_field_forbidden", 400, { fields: immutable });
  const unknown = Object.keys(patch).filter((key) => !TOP_LEVEL_SECTIONS.includes(key));
  if (unknown.length) throw configError("instance_config_unknown_top_level_field", 400, { fields: unknown });
  for (const section of TOP_LEVEL_SECTIONS) {
    if (section in patch) assertJsonValue(patch[section], `/${section}`);
  }
  const merged = mergePatchValue(normalizeInstanceConfig(current), patch);
  validateInstanceConfig(merged);
  return merged;
}

export function changedInstanceConfigPointers(before = {}, after = {}) {
  const changed = [];
  const visit = (left, right, pointer) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (!plainObject(left) || !plainObject(right)) {
      changed.push(pointer || "/");
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      visit(left[key], right[key], `${pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  };
  for (const section of TOP_LEVEL_SECTIONS) visit(before?.[section] || {}, after?.[section] || {}, `/${section}`);
  return changed;
}

export { TOP_LEVEL_SECTIONS };
