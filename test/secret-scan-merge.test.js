import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { scannerLogOptions } from "../scripts/security/secret-scan.mjs";

const marker = "EXAMPLE_MERGE_ONLY_NO_SECRET";

async function mergeFixture(t) {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-merge-scan-"));
  t.after(() => fs.rm(repository, { recursive: true, force: true, maxRetries: 5 }));
  // No inherited Git config, signing, credentials, hooks or external programs.
  // Plumbing constructs a real two-parent merge without touching the checkout.
  const env = { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (args, input = undefined) => {
    const result = spawnSync("git", ["-C", repository, "-c", "user.name=Example Test",
      "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args],
    { env, input, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error?.message || result.stderr}`);
    return result.stdout.trim();
  };
  git(["init", "--quiet", "--bare", "--template="]);
  const tree = content => {
    const blob = git(["hash-object", "-w", "--stdin"], content);
    return git(["mktree"], `100644 blob ${blob}\tfixture.txt\n`);
  };
  const commit = (treeId, parents, title) => git(["commit-tree", treeId,
    ...parents.flatMap(parent => ["-p", parent])], title + "\n");
  const base = commit(tree("initial content\n"), [], "Synthetic base");
  const left = commit(tree("left branch content\n"), [base], "Synthetic left branch");
  const right = commit(tree("right branch content\n"), [base], "Synthetic right branch");
  const merge = commit(tree(`${marker}\n`), [left, right], "Synthetic merge resolution");
  git(["update-ref", "refs/heads/main", merge]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  assert.deepEqual(git(["show", "--no-patch", "--format=%P", merge]).split(" "), [left, right]);
  for (const parent of [base, left, right]) assert.equal(git(["show", `${parent}:fixture.txt`]).includes(marker), false);
  return { git, base, merge };
}

for (const scope of ["explicit target history", "commit range"]) {
  test(`secret scan includes merge-only additions across ${scope}`, async t => {
    const { git, base, merge } = await mergeFixture(t);
    const baseCommit = scope === "commit range" ? base : "";
    const oldOptions = baseCommit ? `${baseCommit}..HEAD` : "--all";
    const oldDiff = git(["log", "-p", "-U0", oldOptions]);
    assert.equal(oldDiff.includes(marker), false, "fixture must reproduce the old merge omission");

    // Gitleaks splits --log-opts on spaces and appends the resulting arguments
    // to git log -p -U0. Exercise that same parser-visible patch stream.
    const reviewedOptions = scannerLogOptions({ commits: [merge], baseCommit }).split(" ");
    const reviewedDiff = git(["log", "-p", "-U0", ...reviewedOptions]);
    assert.match(reviewedDiff, new RegExp(`^\\+${marker}$`, "m"));
    assert.ok(reviewedOptions.includes("--no-ext-diff"));
    assert.ok(reviewedOptions.includes("--no-textconv"));
  });
}

test("scanner log options reject revision arguments that could become Git options", () => {
  for (const baseCommit of ["HEAD", "--all", "a".repeat(40) + " --textconv", "a".repeat(40) + "\n--ext-diff"]) {
    assert.throws(() => scannerLogOptions({ commits: ["b".repeat(40)], baseCommit }), /explicit_scan_scope_required/);
  }
});
