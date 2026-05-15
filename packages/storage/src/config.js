import { ensureDataDirs } from "./paths.js";
import { appendEvent, readJson, writeJson, writeSecretJson } from "./store.js";

const secretKeys = new Set(["openaiApiKey"]);

function redactValue(key, value) {
  if (!secretKeys.has(key)) return value;
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export function redactConfig(config = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(config || {})) {
    redacted[key] = redactValue(key, value);
  }
  return redacted;
}

export async function readConfig(env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.config, {});
}

export async function writeConnectorConfig(id, patch, env = process.env) {
  const paths = await ensureDataDirs(env);
  const config = await readConfig(env);
  const publicPatch = {};
  const secretPatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (secretKeys.has(key)) {
      secretPatch[key] = value;
    } else {
      publicPatch[key] = value;
    }
  }
  const next = {
    ...config,
    [id]: {
      ...(config[id] || {}),
      ...publicPatch,
      updatedAt: new Date().toISOString(),
    },
  };
  await writeJson(paths.config, next);
  if (Object.keys(secretPatch).length) {
    const currentSecrets = await readJson(`${paths.secrets}/${id}.json`, {});
    await writeSecretJson(`${paths.secrets}/${id}.json`, {
      ...currentSecrets,
      ...secretPatch,
      updatedAt: new Date().toISOString(),
    });
  }
  await appendEvent({ type: "connector_config_updated", connector: id }, env);
  return redactConfig({ ...next[id], ...secretPatch });
}

export async function readConnectorConfig(id, env = process.env) {
  const paths = await ensureDataDirs(env);
  const config = await readConfig(env);
  const secrets = await readJson(`${paths.secrets}/${id}.json`, {});
  return { ...(config[id] || {}), ...secrets };
}

export async function publicConfig(env = process.env) {
  const config = await readConfig(env);
  const paths = await ensureDataDirs(env);
  const entries = [];
  for (const [key, value] of Object.entries(config)) {
    const secrets = await readJson(`${paths.secrets}/${key}.json`, {});
    entries.push([key, redactConfig({ ...value, ...secrets })]);
  }
  return Object.fromEntries(entries);
}
