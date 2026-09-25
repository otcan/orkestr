import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Reserve without following or overwriting an existing file. A killed process
// leaves an explicitly incomplete report, never a stale successful report.
export async function createEvidence(target, metadata) {
  const handle = await fs.open(target, "wx", 0o600);
  const identity = await handle.stat();
  const report = { schemaVersion: 2, runId: randomUUID(), ...metadata,
    startedAt: new Date().toISOString(), endedAt: null, complete: false, ok: false,
    category: "scan_incomplete", scannerExitStatus: null, refCount: null, revisionCount: null };
  const write = async () => {
    const current = await fs.lstat(target);
    if (!current.isFile() || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("evidence_publication_failed");
    // Invalidate the existing JSON first; interruption cannot retain old PASS.
    await handle.truncate(0);
    const data = Buffer.from(JSON.stringify(report, null, 2) + "\n");
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
      if (!bytesWritten) throw new Error("evidence_publication_failed");
      offset += bytesWritten;
    }
    await handle.sync();
    const directory = await fs.open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
  try { await write(); } catch (error) { await handle.close(); throw error; }
  return { report, async checkpoint(patch) { Object.assign(report, patch); await write(); },
    async finish(patch) { Object.assign(report, patch, { endedAt: new Date().toISOString() }); await write(); },
    close: () => handle.close() };
}

export function aggregateFindings(findings) {
  const detectors = Object.create(null), categories = Object.create(null);
  for (const finding of findings) {
    detectors[finding.detector] = (detectors[finding.detector] || 0) + 1;
    const category = finding.status === "reviewed_nonsecret" ? finding.classification : "needs_private_triage";
    categories[category] = (categories[category] || 0) + 1;
  }
  const unresolved = findings.filter(row => row.status !== "reviewed_nonsecret").length;
  return { findings: findings.length, unresolved, reviewed: findings.length - unresolved, detectors, categories };
}
