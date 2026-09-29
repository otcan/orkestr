// Minimal read-only zip reader for GitHub Actions artifact archives. It reads
// the central directory, inflates stored/deflated file entries in memory and
// returns { path, sha256, size } rows for content-manifest comparison. No
// entry is ever written to disk.
import crypto from "node:crypto";
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new Error("zip_eocd_missing");
}

function centralDirectory(buffer) {
  const eocd = findEocd(buffer);
  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Error("zip64_locator_missing");
    const zip64 = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(zip64) !== ZIP64_EOCD) throw new Error("zip64_eocd_missing");
    count = Number(buffer.readBigUInt64LE(zip64 + 32));
    offset = Number(buffer.readBigUInt64LE(zip64 + 48));
  }
  return { count, offset };
}

function zip64Extra(extra, sizes) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    if (id === 0x0001) {
      let field = cursor + 4;
      const next = () => { const value = Number(extra.readBigUInt64LE(field)); field += 8; return value; };
      if (sizes.uncompressed === 0xffffffff) sizes.uncompressed = next();
      if (sizes.compressed === 0xffffffff) sizes.compressed = next();
      if (sizes.localOffset === 0xffffffff) sizes.localOffset = next();
    }
    cursor += 4 + length;
  }
  return sizes;
}

export function zipEntries(buffer, { maxEntryBytes = 512 * 1024 * 1024, includeData = false } = {}) {
  const { count, offset: start } = centralDirectory(buffer);
  const rows = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error("zip_central_header_invalid");
    const method = buffer.readUInt16LE(offset + 10);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const extra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const sizes = zip64Extra(extra, {
      compressed: buffer.readUInt32LE(offset + 20),
      uncompressed: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (sizes.uncompressed > maxEntryBytes) throw new Error("zip_entry_too_large");
    const local = sizes.localOffset;
    if (buffer.readUInt32LE(local) !== LOCAL) throw new Error("zip_local_header_invalid");
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(dataStart, dataStart + sizes.compressed);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    else throw new Error(`zip_method_unsupported:${method}`);
    if (data.length !== sizes.uncompressed) throw new Error("zip_entry_size_mismatch");
    rows.push({ path: name, sha256: crypto.createHash("sha256").update(data).digest("hex"), size: data.length, ...(includeData ? { data } : {}) });
  }
  return rows;
}
