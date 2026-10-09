import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { denylistPath, loadDenylist, parseDenylist, scanDenylist } from "../scripts/security/oss-private-denylist.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
// Built at runtime so the absent token never appears in the scanned tree.
const absentToken = ["absent", "fake", "slug", "zz"].join("-");

function runBoundaryCheck(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.ORKESTR_OVERLAY_DIR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/oss-boundary-check.mjs"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => resolve({ code, output }));
  });
}

test("private denylist matches whole tokens case-insensitively and supports re: entries", () => {
  const entries = parseDenylist("# comment\n\nacme-desk\nre:fake-host-[0-9]+\\.internal\n");
  assert.equal(entries.length, 2);
  const text = "ok line\nslug ACME-DESK here\nacme-desktop is another token\nping fake-host-42.internal\n";
  assert.deepEqual(scanDenylist(text, entries), [{ line: 2, entry: 1 }, { line: 4, entry: 2 }]);
  assert.deepEqual(scanDenylist(text, []), []);
});

test("private denylist path prefers the env file over the overlay default", () => {
  assert.deepEqual(denylistPath({}), { file: "", explicit: false });
  assert.equal(denylistPath({ ORKESTR_OVERLAY_DIR: "/srv/overlay" }).file, "/srv/overlay/oss-denylist.txt");
  assert.equal(denylistPath({ ORKESTR_OVERLAY_DIR: "/srv/overlay", ORKESTR_OSS_PRIVATE_DENYLIST: "/srv/deny.txt" }).file, "/srv/deny.txt");
});

test("private denylist load is optional for overlays but strict for explicit or in-repo files", async () => {
  const overlay = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-denylist-overlay-"));
  assert.deepEqual((await loadDenylist({ ORKESTR_OVERLAY_DIR: overlay })).entries, []);
  await assert.rejects(loadDenylist({ ORKESTR_OSS_PRIVATE_DENYLIST: path.join(overlay, "missing.txt") }), /Cannot read/);
  await assert.rejects(loadDenylist({ ORKESTR_OSS_PRIVATE_DENYLIST: path.join(repoRoot, "deny.txt") }, { repoRoot }), /outside the repository/);
});

test("OSS boundary check fails on private denylist hits without echoing the entry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-denylist-"));
  const file = path.join(dir, "deny.txt");
  await fs.writeFile(file, `# fake identifiers only\n${absentToken}\nparent-desk-alpha\n`);
  const failed = await runBoundaryCheck({ ORKESTR_OSS_PRIVATE_DENYLIST: file });
  assert.equal(failed.code, 1);
  assert.match(failed.output, /test\/isolation-audit\.test\.js:\d+: private denylist entry #2/);
  assert.doesNotMatch(failed.output, /entry #1\b/);
  assert.doesNotMatch(failed.output, /parent-desk-alpha/);

  await fs.writeFile(file, `${absentToken}\n`);
  const passed = await runBoundaryCheck({ ORKESTR_OSS_PRIVATE_DENYLIST: file });
  assert.equal(passed.code, 0, passed.output);
  assert.match(passed.output, /1 private denylist entries/);
});
