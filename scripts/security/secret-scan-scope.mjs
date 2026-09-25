import { spawnSync } from "node:child_process";

export const scanEnvironment = Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" });
export const immutableCommit = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const validRef = value => value === "HEAD" || immutableCommit(value) ||
  (typeof value === "string" && /^refs\/(?:heads|remotes|tags)\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes("..") && !value.endsWith("/") && !value.endsWith(".lock"));

export function scannerLogOptions({ commits, baseCommit = "" } = {}) {
  if (!Array.isArray(commits) || !commits.length || commits.length > 100 || !commits.every(immutableCommit) ||
      (baseCommit && (!immutableCommit(baseCommit) || commits.length !== 1))) throw new Error("explicit_scan_scope_required");
  return `--full-history --diff-merges=separate --no-ext-diff --no-textconv ${baseCommit ? `${baseCommit}..${commits[0]}` : commits.join(" ")}`;
}

export function validateScopeRequest({ targetRef, expectedCommit, baseCommit = "", approvedRefs = [] }) {
  if (!validRef(targetRef) || !immutableCommit(expectedCommit) || !Array.isArray(approvedRefs) || approvedRefs.length > 99 ||
      !approvedRefs.every(ref => validRef(ref) && ref.startsWith("refs/")) || new Set(approvedRefs).size !== approvedRefs.length ||
      (baseCommit && (!immutableCommit(baseCommit) || approvedRefs.length))) throw new Error("explicit_scan_scope_required");
  return { targetRef, targetCommit: expectedCommit, baseCommit: baseCommit || null, approvedRefs };
}

export function resolveScope({ repository, targetRef, expectedCommit, baseCommit = "", approvedRefs = [] }) {
  validateScopeRequest({ targetRef, expectedCommit, baseCommit, approvedRefs });
  const git = args => {
    const result = spawnSync("git", ["--no-replace-objects", "-C", repository, ...args],
      { env: scanEnvironment, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error("scan_revision_unavailable");
    return result.stdout.trim();
  };
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") throw new Error("scan_history_incomplete");
  const resolve = ref => {
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (!immutableCommit(commit)) throw new Error("scan_revision_unavailable");
    return commit;
  };
  if (resolve(targetRef) !== expectedCommit) throw new Error("scan_target_mismatch");
  if (resolve("HEAD") !== expectedCommit) throw new Error("scan_stale_checkout");
  const refs = [...new Set([targetRef, ...approvedRefs])].map(ref => ({ ref, commit: resolve(ref) }));
  if (baseCommit) {
    if (resolve(baseCommit) !== baseCommit) throw new Error("scan_base_mismatch");
    git(["merge-base", "--is-ancestor", baseCommit, expectedCommit]);
  }
  const commits = [...new Set(refs.map(row => row.commit))];
  const revisions = baseCommit ? [`${baseCommit}..${expectedCommit}`] : commits;
  const count = git(["rev-list", "--count", ...revisions, "--"]);
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error("scan_revision_count_invalid");
  return { scope: baseCommit ? "commit_range" : approvedRefs.length ? "approved_reachable_refs" : "target_history",
    targetRef, targetCommit: expectedCommit, baseCommit: baseCommit || null, refs, refCount: refs.length,
    revisionCount: Number(count), logOptions: scannerLogOptions({ commits, baseCommit }) };
}
