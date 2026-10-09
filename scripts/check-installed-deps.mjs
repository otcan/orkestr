import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "./main-module.mjs";

// The committed web bundle is only reproducible with the toolchain pinned in
// package-lock.json. A checkout whose node_modules drifted (for example after a
// lockfile bump without `npm ci`) minifies differently and rewrites
// dist/web/browser/main.js even when apps/web did not change.

const TOP_LEVEL_PACKAGE = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/;

export function findInstalledDependencyDrift(root = process.cwd()) {
  const lockPath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockPath)) return [];
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const drift = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    const name = key.match(TOP_LEVEL_PACKAGE)?.[1];
    if (!name || !entry?.version || entry.link) continue;
    let installed = "";
    try {
      installed = JSON.parse(fs.readFileSync(path.join(root, key, "package.json"), "utf8")).version || "";
    } catch {
      if (entry.optional || entry.peer) continue;
    }
    if (installed !== entry.version) drift.push({ name, locked: entry.version, installed: installed || "missing" });
  }
  return drift;
}

export function formatDependencyDrift(drift = [], limit = 8, level = "warning") {
  const shown = drift.slice(0, limit).map((item) => `  ${item.name}: installed ${item.installed}, lockfile ${item.locked}`);
  const more = drift.length > limit ? [`  ...and ${drift.length - limit} more`] : [];
  return [
    `${level}: node_modules differs from package-lock.json for ${drift.length} package(s):`,
    ...shown,
    ...more,
    "Build output (dist/web) will not match the committed bundle. Run `npm ci` to rebuild deterministically.",
  ].join("\n");
}

// Local builds only warn; CI passes --strict so a drifted install fails the job.
export function checkInstalledDependencies({ argv = process.argv.slice(2), root = process.cwd(), log = console } = {}) {
  const strict = argv.includes("--strict");
  const drift = findInstalledDependencyDrift(root);
  if (drift.length) log[strict ? "error" : "warn"](formatDependencyDrift(drift, 8, strict ? "error" : "warning"));
  return strict && drift.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = checkInstalledDependencies();
}
