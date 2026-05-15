import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function appHome(env = process.env) {
  return path.resolve(env.ORKESTR_HOME || path.join(os.homedir(), ".orkestr"));
}

export function dataPaths(env = process.env) {
  const home = appHome(env);
  return {
    home,
    browsers: path.join(home, "browsers"),
    messages: path.join(home, "messages"),
    oauth: path.join(home, "oauth"),
    secrets: path.join(home, "secrets"),
    config: path.join(home, "config.json"),
    agents: path.join(home, "agents.json"),
    timers: path.join(home, "timers.json"),
    events: path.join(home, "events.jsonl"),
    whatsapp: path.join(home, "whatsapp.json"),
  };
}

export async function ensureDataDirs(env = process.env) {
  const paths = dataPaths(env);
  await fs.mkdir(paths.home, { recursive: true });
  await fs.mkdir(paths.browsers, { recursive: true });
  await fs.mkdir(paths.messages, { recursive: true });
  await fs.mkdir(paths.oauth, { recursive: true });
  await fs.mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  return paths;
}
