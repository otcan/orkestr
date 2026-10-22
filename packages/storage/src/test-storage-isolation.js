import os from "node:os";
import path from "node:path";

function clean(value = "") {
  return String(value || "").trim();
}

// Snapshots this module produced. They are frozen plain objects whose values
// are already normalized, so snapshotting one again would copy it unchanged.
const snapshots = new WeakSet();

export function snapshotEnvironment(env = process.env) {
  if (env && snapshots.has(env)) return env;
  const snapshot = Object.freeze(Object.fromEntries(
    Object.entries(env || {}).map(([key, value]) => [key, value ?? ""]),
  ));
  snapshots.add(snapshot);
  return snapshot;
}

export function nodeTestStorageIsolationActive(env = process.env) {
  return Boolean(clean(process.env.NODE_TEST_CONTEXT) || clean(env?.NODE_TEST_CONTEXT));
}

export function pathInsideSystemTemp(targetPath = "") {
  const target = path.resolve(clean(targetPath) || ".");
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertTestStoragePath(targetPath = "", env = process.env, store = "storage") {
  const resolved = path.resolve(clean(targetPath) || ".");
  if (!nodeTestStorageIsolationActive(env) || pathInsideSystemTemp(resolved)) return resolved;
  throw Object.assign(new Error(`test_storage_requires_temp_path:${store}:${resolved}`), {
    code: "test_storage_requires_temp_path",
    statusCode: 500,
    store: clean(store) || "storage",
    targetPath: resolved,
  });
}

export function assertTestStorageHome(home = "", env = process.env) {
  return assertTestStoragePath(home, env, "orkestr_home");
}
