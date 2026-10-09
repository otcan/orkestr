// Optional operator denylist for deployment-specific identifiers (desktop or
// thread slugs, people, client names, private hosts) that generic secret
// patterns cannot know about. The list itself is private and must live outside
// this repo: ORKESTR_OSS_PRIVATE_DENYLIST=<file>, or
// $ORKESTR_OVERLAY_DIR/oss-denylist.txt when the overlay is configured.
//
// File format: one entry per line, `#` starts a comment line. Plain entries
// match case-insensitively as whole tokens; `re:<regex>` entries are used as
// case-insensitive regular expressions. Findings report the entry number
// only, never the matched value.
import fs from "node:fs/promises";
import path from "node:path";

export function denylistPath(env = process.env) {
  const explicit = String(env.ORKESTR_OSS_PRIVATE_DENYLIST || "").trim();
  if (explicit) return { file: path.resolve(explicit), explicit: true };
  const overlayDir = String(env.ORKESTR_OVERLAY_DIR || "").trim();
  return { file: overlayDir ? path.join(overlayDir, "oss-denylist.txt") : "", explicit: false };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseDenylist(text = "") {
  const entries = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const pattern = line.startsWith("re:")
      ? new RegExp(line.slice(3), "iu")
      : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(line)}(?![\\p{L}\\p{N}])`, "iu");
    entries.push({ index: entries.length + 1, pattern });
  }
  return entries;
}

export async function loadDenylist(env = process.env, { repoRoot = "" } = {}) {
  const { file, explicit } = denylistPath(env);
  if (!file) return { file: "", entries: [] };
  if (repoRoot) {
    const relative = path.relative(path.resolve(repoRoot), file);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      throw new Error("OSS private denylist must live outside the repository");
    }
  }
  const text = await fs.readFile(file, "utf8").catch((error) => {
    if (explicit || error?.code !== "ENOENT") throw new Error(`Cannot read OSS private denylist (${error?.code || "error"})`);
    return "";
  });
  return { file, entries: parseDenylist(text) };
}

export function scanDenylist(text, entries) {
  const findings = [];
  if (!entries.length) return findings;
  String(text).split("\n").forEach((line, index) => {
    for (const entry of entries) {
      if (entry.pattern.test(line)) findings.push({ line: index + 1, entry: entry.index });
    }
  });
  return findings;
}
