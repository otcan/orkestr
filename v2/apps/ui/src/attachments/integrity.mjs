// Wire compatibility: Core 9cd9268234 attachments.rs. No transport or authority grant.
const MAX = 16 * 1024 * 1024;
// Bound hostile readers independently of byte length, including empty chunks.
export const ATTACHMENT_MAX_READS = 65536;
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
      typeof ref.filename !== 'string' || typeof ref.media_type !== 'string' ||
      typeof ref.sha256 !== 'string' || !Number.isSafeInteger(ref.byte_length) || ref.byte_length < 0 ||
      !['available','removed','inert'].includes(ref.state)) fail('metadata invalid');
    if (ref.state === 'inert') {
      if (!ref.filename || encoder.encode(ref.filename).length > 4096 ||
          encoder.encode(ref.media_type).length > 1024 || encoder.encode(ref.sha256).length > 128 ||
          [ref.filename,ref.media_type,ref.sha256].some(value => value.includes('\0'))) fail('metadata invalid');
    } else if (!ref.filename || encoder.encode(ref.filename).length > 255 ||
      ['.','..'].includes(ref.filename) || /[\p{Cc}/\\:]/u.test(ref.filename) ||
      ref.media_type.length > 127 ||
      !/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(ref.media_type) ||
      ref.byte_length > MAX || !/^[0-9a-f]{64}$/.test(ref.sha256)) fail('metadata invalid');
    // UUID identity is case insensitive, matching the canonical UUID type.
    const id = ref.reference_id.toLowerCase();
    if (seen.has(id)) fail('duplicate reference');
    seen.add(id); if (ref.state !== 'inert') total += ref.byte_length;
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
    if (ref.state === 'removed' || ref.state === 'inert') {
      if (reader != null) fail(ref.state);
      return Object.freeze({state:ref.state, filename:ref.filename, byte_length:ref.byte_length});
    }
    if (!reader) fail('bytes missing');
    const bytes = new Uint8Array(ref.byte_length);
    let length = 0; let reads = 0;
    while (true) {
      check();
      if (++reads > ATTACHMENT_MAX_READS) fail('read budget exceeded');
      const {done,value} = await reader.read();
      check();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('bytes invalid');
      length += value.byteLength;
      if (length > ref.byte_length || length > MAX) fail('length mismatch');
      bytes.set(value, length - value.byteLength);
    }
    if (length !== ref.byte_length) fail('length mismatch');
    check();
    const hash = [...new Uint8Array(await digest(bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
    check();
    if (hash !== ref.sha256) fail('digest mismatch');
    return Object.freeze({state:'verified', filename:ref.filename, media_type:ref.media_type, bytes});
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
