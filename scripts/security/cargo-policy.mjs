import { advisoryId, exactVersion } from "./dependency-policy.mjs";

export const cratesIoSource = "registry+https://github.com/rust-lang/crates.io-index";
export const crateName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

export function validateCargoPolicy(policy, now = Date.now()) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.exceptions) || policy.exceptions.length > 100 || !Number.isFinite(now)) {
    throw new Error("invalid_cargo_policy");
  }
  const keys = new Set();
  for (const row of policy.exceptions) {
    const start = Date.parse(row.approvedAt), end = Date.parse(row.expiresAt);
    const key = JSON.stringify([row.package, row.version, row.advisoryId]);
    // Same seven-day ceiling as the npm policy: an exception is a dated decision, not a permanent allowlist.
    if (!crateName(row.package) || !exactVersion(row.version) || !advisoryId(row.advisoryId) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(row.approvedBy || "") || !/^[A-Z]+-\d+$/.test(row.reviewRef || "") ||
        typeof row.rationale !== "string" || !row.rationale.trim() || row.rationale.length > 600 ||
        !Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now || end <= start || end - start > 7 * 86400000 ||
        keys.has(key)) throw new Error("invalid_or_expired_cargo_exception");
    keys.add(key);
  }
  return policy;
}

// Cargo.lock is generated, so only the generated shape is accepted: anything else
// (hand edits, [[patch.unused]], legacy [metadata], git or alternate-registry sources) fails closed.
export function parseCargoLock(text) {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) throw new Error("invalid_cargo_lock");
  const lines = text.split("\n");
  let index = 0, lockVersion = null;
  while (index < lines.length && (lines[index].startsWith("#") || lines[index] === "")) index++;
  const version = /^version = (\d+)$/.exec(lines[index] || "");
  if (version) { lockVersion = Number(version[1]); index++; }
  if (lockVersion !== 3 && lockVersion !== 4) throw new Error("invalid_cargo_lock");
  const packages = [];
  while (index < lines.length) {
    if (lines[index] === "") { index++; continue; }
    if (lines[index++] !== "[[package]]") throw new Error("invalid_cargo_lock");
    const entry = {};
    for (; index < lines.length && lines[index] !== ""; index++) {
      const field = /^(name|version|source|checksum) = "([^"\\]*)"$/.exec(lines[index]);
      if (field) {
        if (field[1] in entry) throw new Error("invalid_cargo_lock");
        entry[field[1]] = field[2];
      } else if (lines[index] === "dependencies = [" && !("dependencies" in entry)) {
        entry.dependencies = 0;
        for (index++; index < lines.length && lines[index] !== "]"; index++) {
          if (!/^ "[^"\\]+",$/.test(lines[index])) throw new Error("invalid_cargo_lock");
          entry.dependencies++;
        }
        if (lines[index] !== "]") throw new Error("invalid_cargo_lock");
      } else throw new Error("invalid_cargo_lock");
    }
    packages.push(entry);
  }
  if (packages.length < 1 || packages.length > 20000) throw new Error("invalid_cargo_lock");
  const crates = new Map(), workspace = [];
  for (const entry of packages) {
    if (!crateName(entry.name) || !exactVersion(entry.version)) throw new Error("invalid_locked_identity");
    if (entry.source === undefined) {
      // Workspace members carry neither a source nor a checksum.
      if (entry.checksum !== undefined) throw new Error("unsupported_lock_source");
      workspace.push(entry.name);
      continue;
    }
    if (entry.source !== cratesIoSource) throw new Error("unsupported_lock_source");
    if (!/^[a-f0-9]{64}$/.test(entry.checksum || "")) throw new Error("missing_or_invalid_lock_checksum");
    const key = entry.name + "@" + entry.version;
    if (crates.has(key)) throw new Error("duplicate_locked_crate");
    crates.set(key, { package: entry.name, version: entry.version, checksum: entry.checksum });
  }
  if (!crates.size) throw new Error("invalid_cargo_lock");
  return { lockVersion, entries: packages.length, workspace: workspace.sort(),
    crates: [...crates.values()].sort((a, b) => (a.package + "@" + a.version).localeCompare(b.package + "@" + b.version)) };
}

// RustSec marks advisories that are not vulnerabilities with `informational`.
// Unmaintained and notice records are reported; everything else, including
// unsound and any value this scanner does not know, needs a fix or a dated exception.
const reportOnly = new Set(["unmaintained", "notice"]);

export function minimizeCargoAdvisory(pkg, advisory, policy, now = Date.now()) {
  validateCargoPolicy(policy, now);
  if (!advisoryId(advisory?.id) || !Array.isArray(advisory.affected)) throw new Error("invalid_advisory_evidence");
  const affected = advisory.affected.filter(row => row?.package?.ecosystem === "crates.io" && row.package.name === pkg.package);
  if (!affected.length) throw new Error("advisory_package_mismatch");
  const marks = affected.map(row => row.database_specific?.informational ?? null);
  if (marks.some(value => value !== null && typeof value !== "string")) throw new Error("invalid_advisory_evidence");
  // One affected entry without a mark makes the whole record a vulnerability.
  const kind = marks.every(value => value !== null && reportOnly.has(value)) ? "notice" :
    marks.some(value => value === null) ? "vulnerability" :
    marks.every(value => value === "unsound" || reportOnly.has(value)) ? "unsound" : "unknown";
  const fixed = affected.flatMap(row => (row.ranges || []).filter(r => r.type === "SEMVER").flatMap(r => (r.events || []).map(e => e.fixed).filter(Boolean)));
  if (fixed.some(v => !exactVersion(v)) || fixed.length > 100) throw new Error("invalid_advisory_evidence");
  if (advisory.withdrawn && !Number.isFinite(Date.parse(advisory.withdrawn))) throw new Error("invalid_advisory_evidence");
  if (!Number.isFinite(Date.parse(advisory.modified))) throw new Error("invalid_advisory_evidence");
  const aliases = advisory.aliases === undefined ? [] : advisory.aliases;
  if (!Array.isArray(aliases) || aliases.length > 100 || aliases.some(value => !advisoryId(value))) throw new Error("invalid_advisory_evidence");
  const exception = policy.exceptions.some(row => row.package === pkg.package && row.version === pkg.version && row.advisoryId === advisory.id);
  return { package: pkg.package, version: pkg.version, advisoryId: advisory.id, kind,
    status: advisory.withdrawn ? "withdrawn" : kind === "notice" ? "notice" : exception ? "approved_exception" : "open",
    fixedVersion: [...new Set(fixed)].sort().join(",") || null, modified: new Date(advisory.modified).toISOString(), aliases: [...aliases].sort() };
}

// The advisory service returns a RustSec record and its GitHub mirror as two
// findings. Keep the RustSec one so a single exception covers a single advisory.
export function mergeAliases(findings) {
  const rustsec = new Set(findings.filter(row => row.advisoryId.startsWith("RUSTSEC-")).map(row => JSON.stringify([row.package, row.version, row.advisoryId])));
  return findings.filter(row => row.advisoryId.startsWith("RUSTSEC-") ||
    !row.aliases.some(alias => rustsec.has(JSON.stringify([row.package, row.version, alias]))));
}

export const blocksCargoRelease = row => row.status === "open";
