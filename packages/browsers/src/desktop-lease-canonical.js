// Versioned, language-independent JSON value encoding for retired history only.
import { leaseStoreError } from "./desktop-lease-lock.js";

export const MAX_LEGACY_BYTES = 8 * 1024 * 1024;
export const MAX_LEGACY_NODES = 100_000;
export const MAX_LEGACY_DEPTH = 64;
const invalid = () => { throw leaseStoreError("desktop_lease_legacy_encoding_invalid"); };

export function legacyUtf8(value) {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return Buffer.from(value, "utf8");
}

export const compareLegacyKeys = (a, b) => Buffer.compare(legacyUtf8(a), legacyUtf8(b));

export function canonicalLegacyBytes(value) {
  const chunks = [], ancestors = new Set();
  let bytes = 0, nodes = 0;
  const add = (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "ascii");
    bytes += data.length;
    if (bytes > MAX_LEGACY_BYTES) invalid();
    chunks.push(data);
  };
  const visit = (item, depth) => {
    if (++nodes > MAX_LEGACY_NODES || depth > MAX_LEGACY_DEPTH) invalid();
    if (item === null) return add("n");
    if (typeof item === "boolean") return add(item ? "t" : "f");
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0) || Math.abs(item) > Number.MAX_SAFE_INTEGER) invalid();
      const binary = Buffer.alloc(8); binary.writeDoubleBE(item);
      return add(`d${binary.toString("hex")}`);
    }
    if (typeof item === "string") {
      const encoded = legacyUtf8(item); add(`s${encoded.length}:`); return add(encoded);
    }
    if (!item || typeof item !== "object" || ancestors.has(item)) invalid();
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1) invalid();
      add(`a${item.length}:[`);
      for (let i = 0; i < item.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
        visit(descriptor.value, depth + 1);
      }
      add("]");
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) invalid();
      keys.sort(compareLegacyKeys); add(`o${keys.length}:{`);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
        visit(key, depth + 1); visit(descriptor.value, depth + 1);
      }
      add("}");
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return Buffer.concat(chunks, bytes);
}

// JSON.parse alone discards duplicate object keys. This bounded lexical walk
// rejects them (including escaped aliases) before parsing or digesting a value.
export function parseLegacyJson(input) {
  let source;
  try {
    if (typeof input === "string") source = input;
    else {
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
      // TextDecoder normally removes a leading BOM. Refuse original bytes
      // explicitly so receipt hashes cannot authorize a forbidden encoding.
      if (!bytes || bytes.byteLength > MAX_LEGACY_BYTES
          || bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  }
  catch { invalid(); }
  if (Buffer.byteLength(source) > MAX_LEGACY_BYTES) invalid();
  let offset = 0, nodes = 0;
  const white = () => { while (/[\x20\t\r\n]/.test(source[offset] || "x")) offset += 1; };
  const string = () => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset += 1;
      else if (char === '"') {
        try { return JSON.parse(source.slice(start, offset)); } catch { invalid(); }
      }
    }
    invalid();
  };
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const scan = (depth) => {
    if (++nodes > MAX_LEGACY_NODES || depth > MAX_LEGACY_DEPTH) invalid();
    white(); const char = source[offset];
    if (char === '"') { string(); return; }
    if (char === "{" || char === "[") {
      const object = char === "{", end = object ? "}" : "]", keys = new Set();
      offset += 1; white();
      if (source[offset] === end) { offset += 1; return; }
      for (;;) {
        white();
        if (object) {
          if (source[offset] !== '"') invalid();
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key); white();
          if (source[offset++] !== ":") invalid();
        }
        scan(depth + 1); white();
        if (source[offset] === end) { offset += 1; return; }
        if (source[offset++] !== ",") invalid();
      }
    }
    for (const token of ["true", "false", "null"]) {
      if (source.startsWith(token, offset)) { offset += token.length; return; }
    }
    number.lastIndex = offset;
    if (!number.exec(source)) invalid();
    offset = number.lastIndex;
  };
  scan(0); white();
  if (offset !== source.length) invalid();
  let value;
  try { value = JSON.parse(source); } catch { invalid(); }
  canonicalLegacyBytes(value);
  return value;
}
