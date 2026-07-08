import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { dataPaths, ensureDataDirs } from "./paths.js";

const writeQueues = new Map();
const eventArchivePattern = /^events-\d{8}-\d{6}(?:-\d+)?\.jsonl(?:\.gz)?$/;

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
  const payload = normalizeEventPayload({
    ts: new Date().toISOString(),
    ...event,
  }, env);
  await enqueueFileWrite(paths.events, () => appendEventQueued(paths.events, payload, env));
  return payload;
}

export async function rotateEvents(env = process.env, options = {}) {
  const paths = await ensureDataDirs(env);
  return enqueueFileWrite(paths.events, () => rotateEventsQueued(paths.events, env, {
    force: options.force === true,
    compress: options.compress !== false,
    waitForCompression: options.waitForCompression === true,
  }));
}

export async function listEventArchives(env = process.env) {
  const paths = dataPaths(env);
  const entries = await fs.readdir(path.dirname(paths.events), { withFileTypes: true }).catch(() => []);
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !eventArchivePattern.test(entry.name)) continue;
    const filePath = path.join(path.dirname(paths.events), entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    archives.push({
      name: entry.name,
      size: stat.size,
      compressed: entry.name.endsWith(".gz"),
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return archives.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
}

export async function eventArchiveDownloadPath(name, env = process.env) {
  const cleaned = String(name || "").trim();
  if (!eventArchivePattern.test(cleaned)) throw new Error("invalid_event_archive_name");
  const archiveDir = path.dirname(dataPaths(env).events);
  const resolved = path.resolve(archiveDir, cleaned);
  if (path.dirname(resolved) !== path.resolve(archiveDir)) throw new Error("invalid_event_archive_path");
  const stat = await fs.stat(resolved).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isFile()) throw new Error("event_archive_not_found");
  return { path: resolved, stat, name: cleaned };
}

export async function eventStorageStatus(env = process.env) {
  const paths = dataPaths(env);
  const stat = await fs.stat(paths.events).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const archives = await listEventArchives(env);
  const recent = await listEvents(env, 100).catch(() => []);
  return {
    currentPath: paths.events,
    currentSize: stat?.size || 0,
    maxBytes: eventMaxBytes(env),
    maxEventBytes: eventMaxEventBytes(env),
    archiveCount: archives.length,
    archiveBytes: archives.reduce((sum, archive) => sum + Number(archive.size || 0), 0),
    latestArchiveAt: archives[0]?.modifiedAt || "",
    gzipBacklog: archives.filter((archive) => !archive.compressed).length,
    truncationRecent: recent.some((event) => event?.type === "event_payload_truncated"),
    archives,
  };
}

export async function listEvents(env = process.env, limit = 100) {
  const paths = dataPaths(env);
  const requestedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const lines = await readJsonlTailLines(paths.events, requestedLimit, env);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, type: "unparseable_event", raw: line };
      }
    });
}

function positiveBytes(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function eventMaxBytes(env = process.env) {
  return positiveBytes(env.ORKESTR_EVENTS_MAX_BYTES, 128 * 1024 * 1024);
}

function eventMaxEventBytes(env = process.env) {
  return positiveBytes(env.ORKESTR_EVENTS_MAX_EVENT_BYTES, 64 * 1024);
}

function normalizeEventPayload(payload, env = process.env) {
  const maxBytes = eventMaxEventBytes(env);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes <= maxBytes) return payload;
  return {
    ts: payload.ts || new Date().toISOString(),
    type: "event_payload_truncated",
    originalType: String(payload.type || "event").slice(0, 120),
    payloadBytes: bytes,
    maxBytes,
    keys: Object.keys(payload).slice(0, 40),
  };
}

async function appendEventQueued(eventsPath, payload, env = process.env) {
  const line = `${JSON.stringify(payload)}\n`;
  await rotateEventsQueued(eventsPath, env, {
    force: false,
    incomingBytes: Buffer.byteLength(line),
    compress: true,
    waitForCompression: String(env.ORKESTR_EVENTS_GZIP_SYNC || "") === "1",
  });
  await fs.appendFile(eventsPath, line);
}

function eventArchiveName(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
  return `events-${stamp}-${Date.now()}.jsonl`;
}

async function rotateEventsQueued(eventsPath, env = process.env, options = {}) {
  const stat = await fs.stat(eventsPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const currentSize = stat?.size || 0;
  const shouldRotate = options.force || (currentSize > 0 && currentSize + Number(options.incomingBytes || 0) > eventMaxBytes(env));
  if (!shouldRotate) return { rotated: false, path: eventsPath, size: currentSize };
  if (!currentSize) return { rotated: false, path: eventsPath, size: 0, reason: "empty" };

  const archivePath = path.join(path.dirname(eventsPath), eventArchiveName());
  await fs.rename(eventsPath, archivePath);
  await fs.writeFile(eventsPath, "", { flag: "a", mode: 0o600 });
  const result = { rotated: true, archivePath, archiveName: path.basename(archivePath), compressedPath: "", compressedName: "" };
  if (options.compress !== false) {
    const compression = gzipEventArchive(archivePath).then((compressedPath) => {
      result.compressedPath = compressedPath;
      result.compressedName = path.basename(compressedPath);
      return pruneEventArchives(env);
    });
    if (options.waitForCompression) await compression;
    else compression.catch(() => undefined);
  } else {
    await pruneEventArchives(env);
  }
  return result;
}

async function gzipEventArchive(archivePath) {
  const compressedPath = `${archivePath}.gz`;
  await pipeline(createReadStream(archivePath), createGzip(), createWriteStream(compressedPath, { mode: 0o600 }));
  await fs.unlink(archivePath).catch(() => undefined);
  return compressedPath;
}

async function pruneEventArchives(env = process.env) {
  const retentionDays = positiveInteger(env.ORKESTR_EVENTS_ARCHIVE_RETENTION_DAYS, 14);
  const maxFiles = positiveInteger(env.ORKESTR_EVENTS_ARCHIVE_MAX_FILES, 50);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const archives = await listEventArchives(env);
  const removals = new Set();
  for (const archive of archives) {
    const modifiedMs = Date.parse(archive.modifiedAt || "");
    if (Number.isFinite(modifiedMs) && modifiedMs < cutoffMs) removals.add(archive.name);
  }
  for (const archive of archives.slice(maxFiles)) removals.add(archive.name);
  const archiveDir = path.dirname(dataPaths(env).events);
  await Promise.all([...removals].map((name) => fs.unlink(path.join(archiveDir, name)).catch(() => undefined)));
  return { removed: removals.size };
}

async function readJsonlTailLines(filePath, limit, env = process.env) {
  const stat = await fs.stat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.size) return [];

  const initialBytes = positiveBytes(env.ORKESTR_EVENTS_TAIL_INITIAL_BYTES, 64 * 1024);
  const maxBytes = Math.max(initialBytes, positiveBytes(env.ORKESTR_EVENTS_TAIL_MAX_BYTES, 4 * 1024 * 1024));
  let readBytes = Math.min(stat.size, initialBytes);

  while (true) {
    const start = Math.max(0, stat.size - readBytes);
    const raw = await readFileSlice(filePath, start, stat.size - start);
    const newlineIndex = start > 0 ? raw.indexOf("\n") : -1;
    const complete = start > 0 ? (newlineIndex >= 0 ? raw.slice(newlineIndex + 1) : "") : raw;
    const lines = complete.split("\n").filter(Boolean);
    if (lines.length >= limit || start === 0 || readBytes >= maxBytes) return lines.slice(-limit);
    readBytes = Math.min(stat.size, Math.max(readBytes * 2, readBytes + initialBytes), maxBytes);
  }
}

async function readFileSlice(filePath, start, length) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
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
