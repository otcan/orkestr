import { createHash } from "node:crypto";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const packageName = value => typeof value === "string" && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value) && value.length <= 214;
export const exactVersion = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
export const advisoryId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(value);
export const lifecycleNames = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];
export function lifecycleScripts(manifest, root = false) {
  const names = root ? lifecycleNames : lifecycleNames.slice(0, 3);
  return Object.fromEntries(Object.entries(manifest.scripts || {}).filter(([key]) => names.includes(key)).sort());
}
export function validatePolicy(policy, now = Date.now()) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.installScripts) || !Array.isArray(policy.exceptions) ||
      policy.installScripts.length > 100 || policy.exceptions.length > 100 || !Number.isFinite(now)) throw new Error("invalid_dependency_policy");
  const seen = new Set();
  for (const row of policy.installScripts) {
    if (!packageName(row.package) || !exactVersion(row.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity || "") ||
        !/^[a-f0-9]{64}$/.test(row.scriptSha256 || "") || typeof row.rationale !== "string" || !row.rationale.trim() ||
        seen.has(row.package + "@" + row.version)) throw new Error("invalid_lifecycle_review");
    seen.add(row.package + "@" + row.version);
  }
  const exceptionKeys = new Set();
  for (const row of policy.exceptions) {
    const start = Date.parse(row.approvedAt), end = Date.parse(row.expiresAt);
    const key = JSON.stringify([row.package, row.version, row.advisoryId]);
    if (!packageName(row.package) || !exactVersion(row.version) || !advisoryId(row.advisoryId) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(row.approvedBy || "") || !/^[A-Z]+-\d+$/.test(row.reviewRef || "") ||
        !Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now || end <= start || end - start > 7 * 86400000 ||
        exceptionKeys.has(key)) throw new Error("invalid_or_expired_dependency_exception");
    exceptionKeys.add(key);
  }
  return policy;
}

export function reviewLifecycle(name, entry, policy, scripts = null) {
  const reviewed = policy.installScripts.find(row => row.package === name && row.version === entry.version);
  if (entry.hasInstallScript !== undefined && typeof entry.hasInstallScript !== "boolean") throw new Error("invalid_lifecycle_flag");
  if (!entry.hasInstallScript && (reviewed || (scripts && Object.keys(scripts).length))) throw new Error("lifecycle_flag_mismatch");
  if (entry.hasInstallScript && (!reviewed || reviewed.integrity !== entry.integrity ||
      (scripts && reviewed.scriptSha256 !== sha256(JSON.stringify(scripts))))) throw new Error("unreviewed_lifecycle_package");
}

export function inspectLockfile(lock, manifest, policy) {
  validatePolicy(policy);
  if (lock?.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages) || !lock.packages[""] ||
      Object.keys(lock.packages).length < 2 || Object.keys(lock.packages).length > 20000) throw new Error("invalid_lockfile");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const stable = x => JSON.stringify(Object.entries(x || {}).sort());
    if (stable(lock.packages[""][field]) !== stable(manifest[field])) throw new Error("manifest_lock_mismatch");
  }
  if (JSON.stringify(lifecycleScripts(manifest, true)) !== JSON.stringify(policy.root?.scripts)) throw new Error("unreviewed_root_lifecycle");
  const packages = new Map(), entries = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (!/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(location) ||
        !entry || entry.link || entry.inBundle) throw new Error("unsupported_lock_source");
    const name = entry.name || location.split("node_modules/").at(-1);
    if (!packageName(name) || !exactVersion(entry.version)) throw new Error("invalid_locked_identity");
    // Exact registry tarball path: no private hosts, userinfo, ports, query, fragment or redirects.
    const expected = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${entry.version}.tgz`;
    if (entry.resolved !== expected) throw new Error("non_registry_lock_source");
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity || "")) throw new Error("missing_or_invalid_lock_integrity");
    reviewLifecycle(name, entry, policy);
    const key = name + "@" + entry.version;
    const previous = packages.get(key);
    if (previous && previous.integrity !== entry.integrity) throw new Error("conflicting_lock_integrity");
    packages.set(key, { package: name, version: entry.version, integrity: entry.integrity, production: !entry.dev || previous?.production === true });
    entries.push({ ...entry, location, package: name });
  }
  return { entries, packages: [...packages.values()].sort((a, b) => (a.package + a.version).localeCompare(b.package + b.version)) };
}

export function minimizeAdvisory(pkg, advisory, policy, now = Date.now()) {
  validatePolicy(policy, now);
  if (!advisoryId(advisory?.id) || !Array.isArray(advisory.affected)) throw new Error("invalid_advisory_evidence");
  const affected = advisory.affected.filter(row => row.package?.ecosystem === "npm" && row.package.name === pkg.package);
  if (!affected.length) throw new Error("advisory_package_mismatch");
  const ranks = ["low", "moderate", "high", "critical"];
  const severities = [advisory.database_specific?.severity, ...affected.map(row => row.ecosystem_specific?.severity)]
    .filter(value => typeof value === "string").map(value => value.toLowerCase().replace("medium", "moderate"));
  const severity = severities.length && severities.every(s => ranks.includes(s)) ? ranks[Math.max(...severities.map(s => ranks.indexOf(s)))] : "unknown";
  const fixed = affected.flatMap(row => (row.ranges || []).filter(r => r.type === "SEMVER").flatMap(r => (r.events || []).map(e => e.fixed).filter(Boolean)));
  if (fixed.some(v => !exactVersion(v)) || fixed.length > 100) throw new Error("invalid_advisory_evidence");
  if (advisory.withdrawn && !Number.isFinite(Date.parse(advisory.withdrawn))) throw new Error("invalid_advisory_evidence");
  const exception = policy.exceptions.some(row => row.package === pkg.package && row.version === pkg.version && row.advisoryId === advisory.id);
  return { package: pkg.package, version: pkg.version, advisoryId: advisory.id, severity,
    status: advisory.withdrawn ? "withdrawn" : exception ? "approved_exception" : "open", fixedVersion: [...new Set(fixed)].sort().join(",") || null };
}
export const blocksRelease = row => row.status === "open" && ["high", "critical", "unknown"].includes(row.severity);
