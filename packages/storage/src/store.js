import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "./paths.js";

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeSecretJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
