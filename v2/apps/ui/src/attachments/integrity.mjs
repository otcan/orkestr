// Wire compatibility: Core 9788ef14d attachments.rs. No transport or authority grant.
const MAX = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
const fields = (value, allowed, required = allowed) => value && !Array.isArray(value) &&
  typeof value === 'object' && Object.keys(value).every(k => allowed.includes(k)) &&
  required.every(k => Object.hasOwn(value, k));
const fail = reason => { throw new Error(`Attachment ${reason}`); };

export function referenceFor(manifest, scope, referenceId) {
  if (!fields(manifest, ['schema_version','manifest_id','owner_id','conversation_id','references']) ||
      manifest.schema_version !== 1 || !uuid(manifest.manifest_id) || !uuid(manifest.owner_id) ||
      !uuid(manifest.conversation_id) || !Array.isArray(manifest.references) || manifest.references.length > 128) fail('metadata invalid');
  const seen = new Set(); let total = 0;
  for (const ref of manifest.references) {
    if (!fields(ref, ['reference_id','message_id','filename','media_type','byte_length','sha256','state'],
      ['reference_id','filename','media_type','byte_length','sha256','state']) || !uuid(ref.reference_id) ||
      (ref.message_id != null && !uuid(ref.message_id)) ||
      typeof ref.filename !== 'string' || !ref.filename || encoder.encode(ref.filename).length > 255 ||
      ['.','..'].includes(ref.filename) || /[\p{Cc}/\\:]/u.test(ref.filename) ||
      typeof ref.media_type !== 'string' || ref.media_type.length > 127 ||
      !/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(ref.media_type) ||
      !Number.isSafeInteger(ref.byte_length) || ref.byte_length < 0 || ref.byte_length > MAX ||
      typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256) ||
      !['available','removed'].includes(ref.state)) fail('metadata invalid');
    // UUID identity is case insensitive, matching the canonical UUID type.
    const id = ref.reference_id.toLowerCase();
    if (seen.has(id)) fail('duplicate reference');
    seen.add(id); total += ref.byte_length;
    if (total > MAX) fail('manifest exceeds limit');
  }
  const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!same(manifest.owner_id, scope.owner_id) || !same(manifest.conversation_id, scope.conversation_id) ||
      !same(manifest.manifest_id, scope.manifest_id)) fail('scope changed');
  const ref = manifest.references.find(ref => same(ref.reference_id, referenceId));
  if (!ref) fail('reference missing');
  return Object.freeze({...ref});
}

// Callers supply already-authorized metadata and a raw-byte reader, never a URL.
// No save handle or object URL is created here. A tombstone is never verified bytes.
export async function verifyBytes({manifest, scope, referenceId, reader, current, digest = bytes => crypto.subtle.digest('SHA-256', bytes)}) {
  try {
    const ref = referenceFor(manifest, scope, referenceId);
    const check = () => { if (!current()) fail('scope changed'); };
    check();
    if (ref.state === 'removed') {
      if (reader != null) fail('removed');
      return Object.freeze({state:'removed', filename:ref.filename, byte_length:ref.byte_length});
    }
    if (!reader) fail('bytes missing');
    const chunks = []; let length = 0;
    while (true) {
      check();
      const {done,value} = await reader.read();
      check();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('bytes invalid');
      length += value.byteLength;
      if (length > ref.byte_length || length > MAX) fail('length mismatch');
      chunks.push(value.slice());
    }
    if (length !== ref.byte_length) fail('length mismatch');
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    check();
    const hash = [...new Uint8Array(await digest(bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
    check();
    if (hash !== ref.sha256) fail('digest mismatch');
    return Object.freeze({state:'verified', filename:ref.filename, media_type:ref.media_type, bytes});
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
