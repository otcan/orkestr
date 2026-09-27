import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFolderForPrincipal,
  deleteFileForPrincipal,
  listFilesForPrincipal,
  listWorkspaceFoldersForPrincipal,
  saveFilesForPrincipal,
} from "../packages/core/src/workspace-files.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { upsertUser } from "../packages/core/src/users.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-workspace-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: path.join(root, "state"),
    ORKESTR_RUNTIME_WORKSPACE_ROOT: path.join(root, "runtime-workspaces"),
    ORKESTR_ADMIN_USER_ID: "admin",
  };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  const alicePaths = userDataPaths("alice", env);
  const outsideDir = path.join(root, "outside");
  await fs.mkdir(outsideDir, { recursive: true });
  return { root, env, alice, alicePaths, outsideDir };
}

test("listFilesForPrincipal refuses to browse into a directory symlink that escapes the user root", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  const canary = path.join(outsideDir, "canary-secret.txt");
  await fs.writeFile(canary, "top secret");
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.symlink(outsideDir, path.join(alicePaths.files, "escape"));

  const listing = await listFilesForPrincipal(path.join(alicePaths.files, "escape"), alice, env);
  assert.equal(listing.ok, false);
  assert.notEqual(listing.error, undefined);

  const rootListing = await listFilesForPrincipal(alicePaths.files, alice, env);
  assert.equal(rootListing.entries.some((entry) => entry.name === "escape"), false);
});

test("listFilesForPrincipal hides symlink and hard-linked entries from a legitimate listing", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  const outsideFile = path.join(outsideDir, "outside.txt");
  await fs.writeFile(outsideFile, "outside content");
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.writeFile(path.join(alicePaths.files, "real.txt"), "real content");
  await fs.symlink(outsideFile, path.join(alicePaths.files, "link.txt"));
  await fs.link(outsideFile, path.join(alicePaths.files, "hardlink.txt"));

  const listing = await listFilesForPrincipal(alicePaths.files, alice, env);
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ["real.txt"]);
});

test("saveFilesForPrincipal never overwrites through an existing symlink", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  const target = path.join(outsideDir, "target.txt");
  await fs.writeFile(target, "untouched");
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.symlink(target, path.join(alicePaths.files, "upload.txt"));

  const result = await saveFilesForPrincipal(alicePaths.files, [
    { originalname: "upload.txt", buffer: Buffer.from("attacker controlled") },
  ], alice, env);

  assert.deepEqual(result.files, []);
  assert.equal(await fs.readFile(target, "utf8"), "untouched");
});

test("saveFilesForPrincipal never overwrites an existing hard-linked file", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  const linkedElsewhere = path.join(outsideDir, "linked.txt");
  await fs.writeFile(linkedElsewhere, "original");
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.link(linkedElsewhere, path.join(alicePaths.files, "shared.txt"));

  const result = await saveFilesForPrincipal(alicePaths.files, [
    { originalname: "shared.txt", buffer: Buffer.from("clobber") },
  ], alice, env);

  assert.deepEqual(result.files, []);
  assert.equal(await fs.readFile(linkedElsewhere, "utf8"), "original");
});

test("saveFilesForPrincipal still allows overwriting a plain existing file by the same name", async (t) => {
  const { env, alice, alicePaths } = await fixture(t);
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.writeFile(path.join(alicePaths.files, "notes.txt"), "first");

  const result = await saveFilesForPrincipal(alicePaths.files, [
    { originalname: "notes.txt", buffer: Buffer.from("second") },
  ], alice, env);

  assert.deepEqual(result.files.map((f) => f.name), ["notes.txt"]);
  assert.equal(await fs.readFile(path.join(alicePaths.files, "notes.txt"), "utf8"), "second");
});

test("createFolderForPrincipal refuses to create a folder over an existing symlink", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.symlink(outsideDir, path.join(alicePaths.files, "docs"));

  const result = await createFolderForPrincipal(alicePaths.files, "docs", alice, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "file_special_type_forbidden");
});

test("deleteFileForPrincipal refuses to delete through a directory symlink escape", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  const outsideFile = path.join(outsideDir, "keep-me.txt");
  await fs.writeFile(outsideFile, "still here");
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.symlink(outsideDir, path.join(alicePaths.files, "escape"));

  const result = await deleteFileForPrincipal(path.join(alicePaths.files, "escape", "keep-me.txt"), alice, env);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(outsideFile, "utf8"), "still here");
});

test("deleteFileForPrincipal refuses to delete a symlink leaf directly", async (t) => {
  const { env, alice, alicePaths, outsideDir } = await fixture(t);
  await fs.mkdir(alicePaths.files, { recursive: true });
  const linkPath = path.join(alicePaths.files, "link.txt");
  await fs.symlink(path.join(outsideDir, "missing.txt"), linkPath);

  const result = await deleteFileForPrincipal(linkPath, alice, env);
  assert.equal(result.ok, false);
  await assert.doesNotReject(fs.lstat(linkPath));
});

test("deleteFileForPrincipal still deletes a plain file inside the root", async (t) => {
  const { env, alice, alicePaths } = await fixture(t);
  await fs.mkdir(alicePaths.files, { recursive: true });
  await fs.writeFile(path.join(alicePaths.files, "scratch.txt"), "bye");

  const result = await deleteFileForPrincipal(path.join(alicePaths.files, "scratch.txt"), alice, env);
  assert.equal(result.ok, true);
  await assert.rejects(fs.lstat(path.join(alicePaths.files, "scratch.txt")));
});

test("listWorkspaceFoldersForPrincipal refuses a workspace path reached through a symlink escape", async (t) => {
  const { env, alice, outsideDir } = await fixture(t);
  const workspaceRoot = path.join(env.ORKESTR_RUNTIME_WORKSPACE_ROOT, "users", "alice");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.symlink(outsideDir, path.join(workspaceRoot, "escape"));

  const result = await listWorkspaceFoldersForPrincipal(path.join(workspaceRoot, "escape"), alice, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "workspace_path_forbidden");
});

test("legitimate nested browse, upload, folder, and delete flow keeps working inside the exact user root", async (t) => {
  const { env, alice, alicePaths } = await fixture(t);
  await fs.mkdir(alicePaths.files, { recursive: true });

  const created = await createFolderForPrincipal(alicePaths.files, "project", alice, env);
  assert.equal(created.ok, true);
  const nested = path.join(alicePaths.files, "project");

  const uploaded = await saveFilesForPrincipal(nested, [
    { originalname: "readme.md", buffer: Buffer.from("hello") },
  ], alice, env);
  assert.deepEqual(uploaded.files.map((f) => f.name), ["readme.md"]);

  const listing = await listFilesForPrincipal(nested, alice, env);
  assert.deepEqual(listing.entries.map((e) => e.name), ["readme.md"]);

  const deleted = await deleteFileForPrincipal(path.join(nested, "readme.md"), alice, env);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.entries, []);
});
