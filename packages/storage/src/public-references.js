import { randomBytes } from "node:crypto";

export const INSTANCE_PUBLIC_REF_PREFIX = "ins_";
export const THREAD_PUBLIC_REF_PREFIX = "thr_";
export const PUBLIC_REF_ENTROPY_BYTES = 16;

const TOKEN_LENGTH = 22;
const patterns = {
  instance: new RegExp(`^${INSTANCE_PUBLIC_REF_PREFIX}[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`),
  thread: new RegExp(`^${THREAD_PUBLIC_REF_PREFIX}[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`),
};

function publicRefError(code, value = "") {
  const error = new Error(code);
  error.code = code;
  error.value = String(value || "");
  error.statusCode = 400;
  return error;
}

function kindConfig(kind) {
  if (kind === "instance") return { prefix: INSTANCE_PUBLIC_REF_PREFIX, pattern: patterns.instance };
  if (kind === "thread") return { prefix: THREAD_PUBLIC_REF_PREFIX, pattern: patterns.thread };
  throw publicRefError("public_ref_kind_invalid", kind);
}

export function parsePublicRef(value, kind) {
  const text = String(value || "");
  const { prefix, pattern } = kindConfig(kind);
  if (!pattern.test(text)) throw publicRefError(`${kind}_public_ref_invalid`, text);
  const token = text.slice(prefix.length);
  let entropy;
  try {
    entropy = Buffer.from(token, "base64url");
  } catch {
    throw publicRefError(`${kind}_public_ref_invalid`, text);
  }
  if (entropy.length !== PUBLIC_REF_ENTROPY_BYTES || entropy.toString("base64url") !== token) {
    throw publicRefError(`${kind}_public_ref_invalid`, text);
  }
  return text;
}

export function parseInstancePublicRef(value) {
  return parsePublicRef(value, "instance");
}

export function parseThreadPublicRef(value) {
  return parsePublicRef(value, "thread");
}

export function isInstancePublicRef(value) {
  try { parseInstancePublicRef(value); return true; } catch { return false; }
}

export function isThreadPublicRef(value) {
  try { parseThreadPublicRef(value); return true; } catch { return false; }
}

export function generatePublicRef(kind, bytes = randomBytes) {
  const { prefix } = kindConfig(kind);
  const entropy = bytes(PUBLIC_REF_ENTROPY_BYTES);
  if (!Buffer.isBuffer(entropy) || entropy.length !== PUBLIC_REF_ENTROPY_BYTES) {
    throw publicRefError("public_ref_entropy_invalid");
  }
  return parsePublicRef(`${prefix}${entropy.toString("base64url")}`, kind);
}

export function generateInstancePublicRef(bytes = randomBytes) {
  return generatePublicRef("instance", bytes);
}

export function generateThreadPublicRef(bytes = randomBytes) {
  return generatePublicRef("thread", bytes);
}

export function generateUniquePublicRef(kind, reserved = new Set(), bytes = randomBytes) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = generatePublicRef(kind, bytes);
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw publicRefError(`${kind}_public_ref_collision`);
}

export function assertPublicRefInvariant(previous, next, kind, options = {}) {
  const before = String(previous || "");
  const after = String(next || "");
  if (before !== after && (before || (after && options.allowAssignment !== true))) {
    throw publicRefError(`${kind}_public_ref_immutable`, after);
  }
  if (after) parsePublicRef(after, kind);
  return after || null;
}

export function assertUniquePublicRefs(records = [], kind, field = "publicRef") {
  const seen = new Set();
  for (const record of records) {
    const value = String(record?.[field] || "");
    if (!value) continue;
    parsePublicRef(value, kind);
    if (seen.has(value)) throw publicRefError(`${kind}_public_ref_collision`, value);
    seen.add(value);
  }
  return true;
}
