import { createHash } from "node:crypto";
import { prepareLegacyCohort, serializePreparedLegacy } from "../../packages/browsers/src/desktop-lease-legacy.js";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const revokedAt = "2026-01-02T03:04:05.000Z";
export function legacyState() {
  const row = { id: "historical-a", desktopSlug: "synthetic-desk", ownerUserId: "synthetic-owner",
    threadId: "synthetic-thread", mode: "exclusive", acquiredAt: "2025-01-01T00:00:00.000Z",
    heartbeatAt: "2025-01-01T00:00:00.000Z", expiresAt: null, releasedAt: null,
    fencingToken: "synthetic-old-token", fencingVersion: 2, metadata: { retained: ["😀", 0.125] } };
  return { fencingCounter: 7, desktopLeases: [row, { ...row, id: "historical-b",
    releasedAt: "2025-01-02T00:00:00.000Z", futureField: { exact: true } }], unrelated: { keep: "unchanged" } };
}
export function prepared(state = legacyState()) {
  const original = Buffer.from(`${JSON.stringify(state)}\n`);
  const result = prepareLegacyCohort(state, { sourceSha256: sha(original), revokedAt });
  return { ...result, original, bytes: serializePreparedLegacy(result.state) };
}
