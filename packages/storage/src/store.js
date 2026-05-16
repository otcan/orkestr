import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "./paths.js";

const writeQueues = new Map();

export async function readJson(filePath, fallback) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return fallback;
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const recovered = recoverTrailingJson(raw, error);
    if (recovered.ok) return recovered.value;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  return enqueueFileWrite(filePath, () => writeJsonAtomic(filePath, value));
}

export async function writeSecretJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeJson(filePath, value);
  await fs.chmod(filePath, 0o600);
}

export async function appendEvent(event, env = process.env) {
  const paths = await ensureDataDirs(env);
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };
  await fs.appendFile(paths.events, `${JSON.stringify(payload)}\n`);
  return payload;
}

export async function listEvents(env = process.env, limit = 100) {
  const paths = dataPaths(env);
  const raw = await fs.readFile(paths.events, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, type: "unparseable_event", raw: line };
      }
    });
}

function recoverTrailingJson(raw, error) {
  const position = Number(String(error?.message || "").match(/position (\d+)/)?.[1] || 0);
  if (!position) return { ok: false, value: null };
  const trailing = raw.slice(position);
  if (!trailing.trim()) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.slice(0, position)) };
  } catch {
    return { ok: false, value: null };
  }
}

async function enqueueFileWrite(filePath, operation) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous.then(operation, operation);
  writeQueues.set(filePath, next.finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  }));
  return next;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tmp, payload, { mode: 0o600 });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}
