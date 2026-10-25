// Explicit operator-issued history adoption, never authority from a state marker.
import { createHash } from "node:crypto";
import { leaseStoreError } from "./desktop-lease-lock.js";
import { canonicalLegacyBytes, compareLegacyKeys, legacyUtf8, MAX_LEGACY_BYTES } from "./desktop-lease-canonical.js";
import { validateLeaseStructure } from "./desktop-lease-structure.js";

export const LEGACY_COHORT_FORMAT = "orkestr-desktop-retired-cohort-v1";
export const LEGACY_ADOPTION_FORMAT = "orkestr-desktop-legacy-adoption-v1";
export const MAX_LEGACY_RECORDS = 10_000;
export const MAX_ADOPTION_BYTES = 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => { throw leaseStoreError("desktop_lease_legacy_adoption_invalid"); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function normalizeLegacyAdoption(receipt) {
  canonicalLegacyBytes(receipt);
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_ADOPTION_BYTES
      || !exact(receipt, ["format", "sourceSha256", "preparedSha256", "cohort"])
      || receipt.format !== LEGACY_ADOPTION_FORMAT || typeof receipt.sourceSha256 !== "string"
      || !HEX.test(receipt.sourceSha256) || typeof receipt.preparedSha256 !== "string"
      || !HEX.test(receipt.preparedSha256)) refuse();
  const marker = receipt.cohort;
  if (!exact(marker, ["format", "sourceSha256", "generationFloor", "retiredIds", "retiredSha256"])
      || marker.format !== LEGACY_COHORT_FORMAT || marker.sourceSha256 !== receipt.sourceSha256
      || typeof marker.retiredSha256 !== "string" || !HEX.test(marker.retiredSha256) || !Number.isSafeInteger(marker.generationFloor)
      || marker.generationFloor < 1 || marker.generationFloor >= Number.MAX_SAFE_INTEGER
      || !Array.isArray(marker.retiredIds) || marker.retiredIds.length > MAX_LEGACY_RECORDS) refuse();
  let previous;
  for (const id of marker.retiredIds) {
    if (typeof id !== "string" || !id || id.trim() !== id || legacyUtf8(id).length > 4096
        || previous !== undefined && compareLegacyKeys(previous, id) >= 0) refuse();
    previous = id;
  }
  return freeze(structuredClone(receipt));
}

function cohortDigest(marker, records) {
  return sha(canonicalLegacyBytes({ format: LEGACY_COHORT_FORMAT, sourceSha256: marker.sourceSha256,
    generationFloor: marker.generationFloor, records: [...records].sort((a, b) => compareLegacyKeys(a.id, b.id)) }));
}

export function validateLegacyCohort(state, adoption) {
  if (!adoption) {
    if (Object.hasOwn(state, "legacyRetiredCohort")) refuse();
    return new Set();
  }
  canonicalLegacyBytes(state);
  const expected = adoption.cohort, marker = state.legacyRetiredCohort;
  if (!marker || !canonicalLegacyBytes(marker).equals(canonicalLegacyBytes(expected))
      || state.fencingCounter < expected.generationFloor) refuse();
  const ids = new Set(expected.retiredIds), records = state.desktopLeases.filter((lease) => ids.has(lease.id));
  if (records.length !== ids.size || records.some((lease) => !lease.releasedAt
      || lease.fencingVersion >= expected.generationFloor)
      || cohortDigest(expected, records) !== expected.retiredSha256) refuse();
  return ids;
}

export function verifyPreparedLegacyBytes(bytes, state, adoption, initialized) {
  // State cannot declare that first adoption already happened. A forged matching
  // inode string (or an interrupted rename-before-marker) must not skip this pin.
  if (adoption && !initialized
      && (sha(bytes) !== adoption.preparedSha256 || state.fencingCounter !== adoption.cohort.generationFloor)) refuse();
}

export function serializePreparedLegacy(state) {
  canonicalLegacyBytes(state);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_LEGACY_BYTES) refuse();
  return bytes;
}

// Pure offline seam. Caller must pin original bytes and fence every old writer.
// This function neither reads a path nor publishes/adopts any state.
export function prepareLegacyCohort(source, { sourceSha256, revokedAt }) {
  canonicalLegacyBytes(source);
  validateLeaseStructure(source);
  if (typeof sourceSha256 !== "string" || !HEX.test(sourceSha256)
      || typeof revokedAt !== "string" || !Number.isFinite(Date.parse(revokedAt))
      || new Date(revokedAt).toISOString() !== revokedAt
      || Object.hasOwn(source, "lockIdentity") || Object.hasOwn(source, "legacyRetiredCohort")) refuse();
  if (source.desktopLeases.length > MAX_LEGACY_RECORDS || source.fencingCounter >= Number.MAX_SAFE_INTEGER - 1) refuse();
  const state = structuredClone(source);
  for (const lease of state.desktopLeases) {
    if (!lease.releasedAt) Object.assign(lease, { releasedAt: revokedAt,
      releaseReason: "legacy_history_retired", updatedAt: revokedAt });
  }
  const cohort = { format: LEGACY_COHORT_FORMAT, sourceSha256, generationFloor: source.fencingCounter + 1,
    retiredIds: state.desktopLeases.map((lease) => lease.id).sort(compareLegacyKeys), retiredSha256: "" };
  cohort.retiredSha256 = cohortDigest(cohort, state.desktopLeases);
  state.fencingCounter = cohort.generationFloor;
  state.legacyRetiredCohort = cohort;
  const adoption = normalizeLegacyAdoption({ format: LEGACY_ADOPTION_FORMAT, sourceSha256,
    preparedSha256: sha(serializePreparedLegacy(state)), cohort });
  validateLegacyCohort(state, adoption);
  return { state, adoption };
}
