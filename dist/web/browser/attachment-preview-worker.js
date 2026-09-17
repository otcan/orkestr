// No DOM, eval, network, filesystem extraction, or nested archive expansion.
// The caller terminates this worker after five seconds and on viewer close.
const INPUT_LIMIT = 25 * 1024 * 1024;
const EXPANDED_LIMIT = 32 * 1024 * 1024;
const ENTRY_LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;
const COUNT_LIMIT = 1000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
function reject(message = "Unsupported or unsafe archive. Download it instead.") { throw Error(message); }
function safeName(name) {
  if (!name || name.length > 512 || /[\x00-\x1f\x7f\\:]/.test(name) || name.startsWith("/") || name.split("/").some(part => part === "..")) reject();
  return name.replace(/^(\.\/)+/, "");
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function inflateBounded(bytes, format, maximum) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > maximum) reject("Decompressed content exceeds the preview limit.");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const output = new Uint8Array(size); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function textPreview(bytes) {
  const prefix = bytes.subarray(0, TEXT_LIMIT);
  if (prefix.includes(0)) reject("Binary content cannot be previewed as text.");
  // Streaming decode avoids mistaking a truncation in a UTF-8 sequence for a
  // corrupt file. The text is always interpolated, never interpreted as HTML.
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: bytes.length > TEXT_LIMIT }), truncated: bytes.length > TEXT_LIMIT };
}
function numberOctal(bytes) {
  const value = utf8.decode(bytes).replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(value)) reject();
  const number = parseInt(value || "0", 8);
  if (!Number.isSafeInteger(number)) reject();
  return number;
}

export class AttachmentPreview {
  bytes = new Uint8Array(); entries = []; kind = "text";
  async open(bytes, filename, features = {textPreview:true, archivePreview:true}) {
    if (!(bytes instanceof Uint8Array) || bytes.length > INPUT_LIMIT) reject("Preview input exceeds 25 MB.");
    this.bytes = bytes; this.entries = []; this.kind = "text";
    const name = String(filename).toLowerCase();
    const compressed = (bytes[0] === 0x1f && bytes[1] === 0x8b) || (bytes[0] === 0x50 && bytes[1] === 0x4b) || /\.(tar|zip|gz|tgz|rar|7z)$/.test(name);
    if (compressed ? !features.archivePreview : !features.textPreview) reject("This preview type is disabled. Download the file instead.");
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      this.bytes = await inflateBounded(bytes, "gzip", Math.min(EXPANDED_LIMIT, Math.max(ENTRY_LIMIT, bytes.length * 100)));
      if (!/\.(tar\.gz|tgz)$/.test(name)) return { archive: false, ...textPreview(this.bytes), entries: [] };
      this.kind = "tar";
    } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) this.kind = "zip";
    else if (/\.tar$/.test(name)) this.kind = "tar";
    else if (/\.(zip|gz|tgz|rar|7z|bz2|xz)$/.test(name)) reject();
    if (this.kind === "text") return { archive: false, ...textPreview(bytes), entries: [] };
    if (this.kind === "zip") this.zip(); else this.tar();
    return { archive: true, text: "", truncated: false, entries: this.entries.map(({id, name, size, directory}) => ({id, name, size, directory})) };
  }
  add(entry) {
    if (this.entries.length >= COUNT_LIMIT || this.entries.some(item => item.name === entry.name)) reject();
    this.entries.push({ ...entry, id: this.entries.length });
  }
  zip() {
    const b = this.bytes, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u16 = p => v.getUint16(p, true), u32 = p => v.getUint32(p, true);
    let end = -1;
    for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
      if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === b.length) { end = p; break; }
    }
    if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) reject();
    const count = u16(end + 10), start = u32(end + 16), length = u32(end + 12);
    if (count > COUNT_LIMIT || start + length !== end) reject(); // No ZIP64/multipart.
    let p = start, total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || u32(p) !== 0x02014b50) reject();
      const flags = u16(p + 8), method = u16(p + 10), checksum = u32(p + 16), compressed = u32(p + 20), size = u32(p + 24);
      const nameLength = u16(p + 28), extra = u16(p + 30), comment = u16(p + 32), local = u32(p + 42);
      const next = p + 46 + nameLength + extra + comment;
      if (next > end || (flags & ~0x080e) || ![0, 8].includes(method) || u16(p + 34)) reject();
      const mode = (u32(p + 38) >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) reject(); // No links/devices.
      const rawName = utf8.decode(b.subarray(p + 46, p + 46 + nameLength));
      const name = safeName(rawName);
      total += size;
      if (total > EXPANDED_LIMIT || size > Math.max(ENTRY_LIMIT, compressed * 100)) reject("Archive expansion limit exceeded.");
      if (local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) reject();
      const localName = u16(local + 26), localExtra = u16(local + 28), offset = local + 30 + localName + localExtra;
      if (offset + compressed > start || utf8.decode(b.subarray(local + 30, local + 30 + localName)) !== rawName) reject();
      if (!(flags & 8) && (u32(local + 14) !== checksum || u32(local + 18) !== compressed || u32(local + 22) !== size)) reject();
      this.add({name, size, directory: name.endsWith("/"), offset, compressed, method, checksum}); p = next;
    }
    if (p !== end) reject();
  }
  tar() {
    const b = this.bytes; let p = 0, total = 0;
    while (p + 512 <= b.length) {
      const header = b.subarray(p, p + 512);
      if (header.every(byte => byte === 0)) return;
      const checksum = numberOctal(header.subarray(148, 156));
      let actual = 0; for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
      if (actual !== checksum) reject();
      const field = (from, to) => utf8.decode(header.subarray(from, to)).replace(/\0.*$/, "");
      const prefix = field(345, 500), name = safeName([prefix, field(0, 100)].filter(Boolean).join("/"));
      const type = header[156], size = numberOctal(header.subarray(124, 136));
      if (![0, 48, 53].includes(type)) reject("This TAR uses links or unsupported extended records. Download it instead.");
      total += size;
      if (total > EXPANDED_LIMIT || p + 512 + size > b.length) reject();
      this.add({ name, size, directory: type === 53, offset: p + 512 });
      p += 512 + Math.ceil(size / 512) * 512;
    }
    if (p !== b.length) reject();
  }
  async entry(id) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.directory) reject();
    if (entry.size > ENTRY_LIMIT) reject("Entry exceeds the 2 MB preview limit. Download the archive instead.");
    let bytes = this.bytes.subarray(entry.offset, entry.offset + (this.kind === "zip" ? entry.compressed : entry.size));
    if (this.kind === "zip") {
      if (entry.method === 8) bytes = await inflateBounded(bytes, "deflate-raw", Math.min(ENTRY_LIMIT, entry.size));
      if (bytes.length !== entry.size || crc32(bytes) !== entry.checksum) reject("Archive integrity check failed.");
    }
    if (/\.(zip|tar|gz|tgz|rar|7z)$/i.test(entry.name)) reject("Nested archives are download-only.");
    return textPreview(bytes);
  }
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const preview = new AttachmentPreview();
  self.onmessage = async event => {
    try {
      const result = event.data.bytes ? await preview.open(event.data.bytes, event.data.filename, event.data.features) : await preview.entry(event.data.entryId);
      self.postMessage({ ...result, error: "" });
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "Preview failed.", text: "" }); }
  };
}
