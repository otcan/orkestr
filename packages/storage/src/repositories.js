import path from "node:path";
import { dataPaths, ensureDataDirs, userDataPaths } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { listThreadRecords, saveThreadRecords } from "./thread-registry.js";

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
    async pathForThread(threadId) {
      const paths = await ensureDataDirs(env);
      return path.join(paths.threadMessages, `${safeThreadId(threadId)}.json`);
    },
    async list(threadId) {
      return readJson(await this.pathForThread(threadId), []);
    },
    async save(threadId, messages) {
      return writeJson(await this.pathForThread(threadId), Array.isArray(messages) ? messages : []);
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
