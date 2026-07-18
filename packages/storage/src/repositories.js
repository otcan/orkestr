import path from "node:path";
import fs from "node:fs/promises";
import { dataPaths, ensureDataDirs, userDataPaths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { listThreadRecords, saveThreadRecords } from "./thread-registry.js";
import {
  appendThreadMessageRecord,
  deleteThreadMessageRecords,
  findThreadMessageRecord,
  listThreadMessageCandidates,
  listThreadMessageRows,
  nextThreadMessageCursor,
  replaceThreadMessageRecords,
  threadMessageRecord,
  threadMessageRecordsByStates,
  threadMessageStoreFingerprint,
  threadMessageStoreFingerprints,
  threadMessageStoreEnabled,
  updateThreadMessageRecord,
} from "./thread-message-registry.js";

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

export function createThreadRepository(env = process.env) {
  return {
    list() {
      return listThreadRecords(env);
    },
    save(threads) {
      return saveThreadRecords(threads, env);
    },
  };
}

export function createThreadMessageRepository(env = process.env) {
  return {
    usesSqlite() {
      return threadMessageStoreEnabled(env);
    },
    async pathForThread(threadId) {
      const paths = dataPaths(env);
      return path.join(paths.threadMessages, `${safeThreadId(threadId)}.json`);
    },
    async list(threadId) {
      const stored = await listThreadMessageRows(threadId, env);
      if (stored) return stored;
      return readJson(await this.pathForThread(threadId), []);
    },
    async listCandidates(threadId, options = {}) {
      const stored = await listThreadMessageCandidates(threadId, options, env);
      if (stored) return stored;
      return null;
    },
    find(threadId, fields = {}) {
      return findThreadMessageRecord(threadId, fields, env);
    },
    get(threadId, messageId) {
      return threadMessageRecord(threadId, messageId, env);
    },
    listByStates(threadId, states = []) {
      return threadMessageRecordsByStates(threadId, states, env);
    },
    nextCursor(threadId) {
      return nextThreadMessageCursor(threadId, env);
    },
    async append(threadId, message) {
      return appendThreadMessageRecord(threadId, message, env);
    },
    async update(threadId, messageId, message) {
      return updateThreadMessageRecord(threadId, messageId, message, env);
    },
    fingerprint(threadId) {
      return threadMessageStoreFingerprint(threadId, env);
    },
    fingerprints(threadIds) {
      return threadMessageStoreFingerprints(threadIds, env);
    },
    async save(threadId, messages) {
      if (await replaceThreadMessageRecords(threadId, messages, env)) return messages;
      return writeJson(await this.pathForThread(threadId), Array.isArray(messages) ? messages : []);
    },
    async mutate(threadId, operation) {
      const filePath = await this.pathForThread(threadId);
      const current = await this.list(threadId);
      const messages = Array.isArray(current) ? current : [];
      const result = await operation(messages, filePath);
      if (Array.isArray(result)) {
        await this.save(threadId, result);
        return result;
      }
      if (result && Array.isArray(result.messages)) {
        await this.save(threadId, result.messages);
      }
      return result;
    },
    async delete(threadId) {
      if (await deleteThreadMessageRecords(threadId, env)) return;
      return fs.rm(await this.pathForThread(threadId), { force: true });
    },
  };
}

export function createConnectorStateRepository(env = process.env) {
  return {
    async whatsappStatePath() {
      return dataPaths(env).whatsapp;
    },
    async readWhatsAppState(fallback = {}) {
      return readJson(await this.whatsappStatePath(), fallback);
    },
    async writeWhatsAppState(value) {
      return writeJson(await this.whatsappStatePath(), value);
    },
  };
}

export function createTimerRepository(env = process.env) {
  return {
    async list() {
      const paths = await ensureDataDirs(env);
      const timers = await readJson(paths.timers, []);
      return Array.isArray(timers) ? timers : [];
    },
    async save(timers) {
      const paths = await ensureDataDirs(env);
      return writeJson(paths.timers, Array.isArray(timers) ? timers : []);
    },
  };
}

export function createUserRepository(env = process.env) {
  return {
    async list() {
      const paths = await ensureDataDirs(env);
      const users = await readJson(paths.users, []);
      return Array.isArray(users) ? users : [];
    },
    async save(users) {
      const paths = await ensureDataDirs(env);
      return writeJson(paths.users, Array.isArray(users) ? users : []);
    },
  };
}

export function createUserIdentityRepository(env = process.env) {
  return {
    async list(userId) {
      const paths = userDataPaths(userId, env);
      const identities = await readJson(paths.identities, []);
      return Array.isArray(identities) ? identities : [];
    },
    async save(userId, identities) {
      await ensureDataDirs(env);
      const paths = userDataPaths(userId, env);
      return writeJson(paths.identities, Array.isArray(identities) ? identities : []);
    },
  };
}
