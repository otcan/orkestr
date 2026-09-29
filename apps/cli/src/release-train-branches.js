// `orkestr release-train sync-branches`: after a release, fast-forward every
// clean worktree branch whose tip is an ancestor of the released commit and
// push them together. Never forces, never rewrites, and reports what it skipped.

export function parseWorktreeList(text = "") {
  const rows = [];
  let current = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: "", head: "", detached: false, bare: false };
      rows.push(current);
    } else if (!current) continue;
    else if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
  }
  return rows;
}

// Dirty = any status entry other than an untracked node_modules directory.
export function dirtyEntries(porcelain = "") {
  return String(porcelain).split("\n").filter(Boolean).filter((line) => !/^\?\? node_modules\/?$/.test(line));
}

export async function syncBranches({ git, sha, pathPrefix = "", dryRun = false }) {
  const worktrees = parseWorktreeList(await git(["worktree", "list", "--porcelain"]))
    .filter((row) => row.branch && !row.bare && (!pathPrefix || row.path.startsWith(pathPrefix)));
  const results = [];
  const seen = new Set();
  for (const row of worktrees) {
    if (seen.has(row.branch)) continue;
    seen.add(row.branch);
    const entry = { branch: row.branch, path: row.path, action: "", uniqueCommits: 0, missingCommits: 0 };
    results.push(entry);
    const tip = await git(["rev-parse", `refs/heads/${row.branch}`]);
    const status = await git(["status", "--porcelain", "--untracked-files=normal"], { cwd: row.path, allowFailure: true });
    const dirty = status.code === 0 ? dirtyEntries(status.stdout) : ["status_unavailable"];
    entry.missingCommits = Number(await git(["rev-list", "--count", `${tip}..${sha}`])) || 0;
    const ancestor = (await git(["merge-base", "--is-ancestor", tip, sha], { allowFailure: true })).code === 0;
    if (!ancestor) {
      entry.action = "skipped-diverged";
      entry.uniqueCommits = Number(await git(["rev-list", "--count", `${sha}..${tip}`])) || 0;
      if (dirty.length) entry.dirtyFiles = dirty.length;
      continue;
    }
    if (tip !== sha && dirty.length) {
      entry.action = "skipped-dirty";
      entry.dirtyFiles = dirty.length;
      continue;
    }
    if (tip !== sha) {
      entry.action = dryRun ? "would-fast-forward" : "fast-forwarded";
      if (!dryRun) await git(["merge", "--ff-only", "--quiet", sha], { cwd: row.path });
    } else {
      entry.action = "current";
    }
    const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${row.branch}`], { allowFailure: true });
    const remoteSha = remote.code === 0 ? remote.stdout.trim() : "";
    if (!remoteSha) entry.push = "local-only";
    else if (remoteSha === sha) entry.push = "up-to-date";
    else if ((await git(["merge-base", "--is-ancestor", remoteSha, sha], { allowFailure: true })).code === 0) entry.push = dryRun ? "would-push" : "pending";
    else entry.push = "remote-diverged";
  }
  const toPush = results.filter((entry) => entry.push === "pending").map((entry) => entry.branch);
  let pushed = { ok: true, branches: [] };
  if (toPush.length && !dryRun) {
    const push = await git(["push", "origin", ...toPush.map((branch) => `refs/heads/${branch}:refs/heads/${branch}`)], { allowFailure: true });
    pushed = { ok: push.code === 0, branches: toPush, ...(push.code === 0 ? {} : { error: String(push.stderr || push.stdout).trim().split("\n").slice(-3).join(" ") }) };
    for (const entry of results) if (entry.push === "pending") entry.push = pushed.ok ? "pushed" : "push-failed";
  }
  const blocked = results.filter((entry) => entry.action.startsWith("skipped"));
  return { ok: pushed.ok && blocked.length === 0, sha, dryRun, branches: results, pushed, blocked: blocked.map((entry) => entry.branch) };
}

export function formatSyncBranches(result) {
  const lines = [`Branch sync to ${result.sha.slice(0, 12)}${result.dryRun ? " (dry run)" : ""}:`];
  for (const entry of result.branches) {
    const detail = entry.action === "skipped-diverged" ? ` (${entry.uniqueCommits} unique commit(s), ${entry.missingCommits} missing)`
      : entry.action === "skipped-dirty" ? ` (${entry.dirtyFiles} local change(s), ${entry.missingCommits} missing)` : "";
    lines.push(`  ${entry.branch}: ${entry.action}${detail}${entry.push ? `, remote ${entry.push}` : ""}`);
  }
  if (result.pushed.branches.length) lines.push(result.pushed.ok ? `Pushed ${result.pushed.branches.length} branch(es) in one push.` : `Push failed: ${result.pushed.error}`);
  if (result.blocked.length) lines.push(`Not synced: ${result.blocked.join(", ")}. Resolve these before calling the release train complete.`);
  return lines.join("\n");
}
