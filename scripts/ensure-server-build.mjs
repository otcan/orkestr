#!/usr/bin/env node
// Runs before `npm start`. A fresh clone has no server build yet, so build it
// once (about 15 seconds); installs and the Docker image already have it, and
// then this does nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist/server/apps/server/src/server.js");

if (!fs.existsSync(entry)) {
  if (!fs.existsSync(path.join(root, "node_modules/typescript"))) {
    console.error("Orkestr is not built yet and its build tools are missing. Run `npm ci`, then `npm start` again.");
    process.exit(1);
  }
  console.log("First start: building the Orkestr server (about 15 seconds)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "-s", "build:server"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
