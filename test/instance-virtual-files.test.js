import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createInstanceFolder,
  downloadInstanceFile,
  listInstanceFiles,
  previewInstanceFile,
  uploadInstanceFiles,
} from "../packages/core/src/instance-virtual-files.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-instance-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      ORKESTR_HOME: path.join(root, "state"),
      ORKESTR_RUNTIME_WORKSPACE_ROOT: path.join(root, "runtime-workspaces"),
      ORKESTR_ADMIN_USER_ID: "admin",
    },
    principal: { kind: "user", userId: "alice", role: "user", source: "test" },
  };
}

test("instance file API exposes logical mounts and supports safe browse/preview/download/upload", async (t) => {
  const { env, principal } = await fixture(t);
  const initial = await listInstanceFiles({}, principal, env);
  assert.equal(initial.mount.id, "files");
  assert.equal(initial.path, "");
  assert.ok(initial.mounts.every((mount) => !("path" in mount) && !("rootPath" in mount)));

  const folder = await createInstanceFolder({ mountId: "files", path: "", name: "notes" }, principal, env);
  assert.ok(folder.entries.some((entry) => entry.name === "notes" && entry.directory));
  const uploaded = await uploadInstanceFiles({
    mountId: "files",
    path: "notes",
    files: [{ originalname: "hello.txt", buffer: Buffer.from("hello instance\n") }],
  }, principal, env);
  const entry = uploaded.entries.find((item) => item.name === "hello.txt");
  assert.equal(entry?.path, "notes/hello.txt");
  assert.equal(entry?.previewable, true);
  const preview = await previewInstanceFile({ mountId: "files", path: entry.path }, principal, env);
  assert.equal(preview.content, "hello instance\n");
  assert.equal(preview.path, "notes/hello.txt");
  const download = await downloadInstanceFile({ mountId: "files", path: entry.path }, principal, env);
  assert.equal(download.buffer.toString("utf8"), "hello instance\n");
});

test("instance file API rejects traversal and hides symlink and hard-link escapes", async (t) => {
  const { root, env, principal } = await fixture(t);
  const initial = await listInstanceFiles({}, principal, env);
  const physicalFiles = path.join(env.ORKESTR_HOME, "users", "alice", "files");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, path.join(physicalFiles, "escape.txt"));
  await fs.link(outside, path.join(physicalFiles, "hard-link.txt"));
  await fs.writeFile(path.join(physicalFiles, ".env"), "SECRET=hidden\n");

  const listing = await listInstanceFiles({ mountId: initial.mount.id }, principal, env);
  assert.equal(listing.entries.some((entry) => entry.name === "escape.txt"), false);
  assert.equal(listing.entries.some((entry) => entry.name === "hard-link.txt"), false);
  assert.equal(listing.entries.some((entry) => entry.name === ".env"), false);
  await assert.rejects(
    previewInstanceFile({ mountId: "files", path: "escape.txt" }, principal, env),
    /instance_file_special_type_forbidden/,
  );
  await assert.rejects(
    previewInstanceFile({ mountId: "files", path: "hard-link.txt" }, principal, env),
    /instance_file_hard_link_forbidden/,
  );
  await assert.rejects(
    listInstanceFiles({ mountId: "files", path: "../" }, principal, env),
    /instance_file_path_forbidden/,
  );
  await assert.rejects(
    previewInstanceFile({ mountId: "files", path: ".env" }, principal, env),
    /instance_file_sensitive_path_forbidden/,
  );
  await assert.rejects(
    uploadInstanceFiles({ mountId: "files", files: [{ originalname: ".env", buffer: Buffer.from("no") }] }, principal, env),
    /instance_file_sensitive_path_forbidden/,
  );
  await assert.rejects(
    createInstanceFolder({ mountId: "files", name: "secrets" }, principal, env),
    /instance_file_sensitive_path_forbidden/,
  );
});

test("instance file preview and download are bounded", async (t) => {
  const { env, principal } = await fixture(t);
  await listInstanceFiles({}, principal, env);
  const physicalFiles = path.join(env.ORKESTR_HOME, "users", "alice", "files");
  const large = path.join(physicalFiles, "large.txt");
  await fs.writeFile(large, "start");
  await fs.truncate(large, 11 * 1024 * 1024);
  await assert.rejects(
    previewInstanceFile({ mountId: "files", path: "large.txt" }, principal, env),
    /instance_file_too_large/,
  );
  await assert.rejects(
    downloadInstanceFile({ mountId: "files", path: "large.txt" }, principal, env),
    /instance_file_too_large/,
  );
});
