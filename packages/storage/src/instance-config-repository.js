import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { emptyInstanceConfig, normalizeInstanceConfig } from "../../shared/src/instance-config-schema.js";
import { dataPaths, ensureDataDirs } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { withStorageFileLock } from "./storage-lock.js";

function clean(value = "") {
  return String(value || "").trim();
}

function storageSegment(internalInstanceId = "") {
  const id = clean(internalInstanceId);
  if (!id) throw Object.assign(new Error("instance_config_internal_id_required"), { statusCode: 500 });
  const slug = id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "instance";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${slug}-${digest}`;
}

export function instanceStatePaths(internalInstanceId, env = process.env) {
  const root = path.join(dataPaths(env).instances, storageSegment(internalInstanceId));
  return {
    root,
    desiredRoot: path.join(root, "desired"),
    statusRoot: path.join(root, "status"),
    desired: path.join(root, "desired", "instance.v1.json"),
    status: path.join(root, "status", "instance.v1.json"),
  };
}

async function ensureInstanceStateDirs(internalInstanceId, env = process.env) {
  await ensureDataDirs(env);
  const paths = instanceStatePaths(internalInstanceId, env);
  await fs.mkdir(paths.desiredRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.statusRoot, { recursive: true, mode: 0o700 });
  return paths;
}

export async function readInstanceConfig(internalInstanceId, env = process.env) {
  const paths = await ensureInstanceStateDirs(internalInstanceId, env);
  const stored = await readJson(paths.desired, null);
  return stored ? normalizeInstanceConfig(stored) : emptyInstanceConfig();
}

export async function instanceConfigExists(internalInstanceId, env = process.env) {
  const paths = await ensureInstanceStateDirs(internalInstanceId, env);
  return fs.stat(paths.desired).then((stats) => stats.isFile(), (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
}

export async function compareAndSwapInstanceConfig(
  internalInstanceId,
  expectedGeneration,
  buildNext,
  env = process.env,
) {
  const paths = await ensureInstanceStateDirs(internalInstanceId, env);
  return withStorageFileLock(paths.desired, async () => {
    const stored = await readJson(paths.desired, null);
    const current = stored ? normalizeInstanceConfig(stored) : emptyInstanceConfig();
    const expected = Number(expectedGeneration);
    if (!Number.isInteger(expected) || expected < 0) {
      throw Object.assign(new Error("instance_config_if_match_required"), { statusCode: 428 });
    }
    if (current.generation !== expected) {
      throw Object.assign(new Error("instance_config_generation_conflict"), {
        statusCode: 409,
        currentGeneration: current.generation,
      });
    }
    const now = new Date().toISOString();
    const proposed = normalizeInstanceConfig(await buildNext(current), now);
    const next = {
      ...proposed,
      schemaVersion: 1,
      generation: current.generation + 1,
      createdAt: current.createdAt || now,
      updatedAt: now,
    };
    await writeJson(paths.desired, next);
    return { current, next };
  });
}

export async function readInstanceStatus(internalInstanceId, env = process.env) {
  const paths = await ensureInstanceStateDirs(internalInstanceId, env);
  return readJson(paths.status, null);
}

export async function writeInstanceStatus(internalInstanceId, status, env = process.env) {
  const paths = await ensureInstanceStateDirs(internalInstanceId, env);
  await writeJson(paths.status, status);
  return status;
}
