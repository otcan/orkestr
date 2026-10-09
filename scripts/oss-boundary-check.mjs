import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDenylist, scanDenylist } from "./security/oss-private-denylist.mjs";
import { scanText } from "./security/oss-secret-patterns.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredBoundaryFiles = [
  "docs/oss-managed-boundary.md",
  "docs/secret-manager.md",
  "docs/private-overlay.md",
  "SECURITY.md",
];

const requiredText = [
  {
    file: "README.md",
    patterns: [
      /local-first workstation for running persistent coding and\s+operations agents/i,
      /persistent threads/i,
      /WhatsApp routing/i,
      /OSS vs managed/i,
    ],
  },
  {
    file: "docs/product.md",
    patterns: [
      /self-hosted Codex control center/i,
      /Simplified OSS Surface/i,
    ],
  },
  {
    file: "docs/oss-managed-boundary.md",
    patterns: [
      /OSS repo/i,
      /managed\/private/i,
      /secret manager/i,
      /private overlay/i,
    ],
  },
  {
    file: "docs/secret-manager.md",
    patterns: [
      /secure-input/i,
      /secret:\/\/user/i,
      /secret:\/\/global/i,
      /metadata only/i,
    ],
  },
];

const generatedDirs = new Set([
  ".angular",
  ".git",
  ".orkestr",
  "dist",
  "node_modules",
  "test",
]);

const scanExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const forbiddenPatterns = [
  { name: "operator Orkestr home", pattern: /\/home\/[^/\s"']+\/\.orkestr-production\b/ },
  { name: "browser profile store", pattern: /\/(Default|Profile [0-9]+)\/(Cookies|Login Data|Local State)\b/ },
];

async function readText(relPath) {
  return fs.readFile(path.join(repoRoot, relPath), "utf8");
}

async function assertRequiredFiles() {
  const missing = [];
  for (const relPath of requiredBoundaryFiles) {
    const stat = await fs.stat(path.join(repoRoot, relPath)).catch(() => null);
    if (!stat?.isFile()) missing.push(relPath);
  }
  if (missing.length) throw new Error(`Missing OSS boundary files:\n${missing.join("\n")}`);
}

async function assertRequiredText() {
  const failures = [];
  for (const item of requiredText) {
    const text = await readText(item.file).catch(() => "");
    for (const pattern of item.patterns) {
      if (!pattern.test(text)) failures.push(`${item.file}: missing ${pattern}`);
    }
  }
  if (failures.length) throw new Error(`OSS boundary text check failed:\n${failures.join("\n")}`);
}

async function walk(dir = ".", { skipDirs = generatedDirs, extensions = scanExtensions } = {}) {
  const entries = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relPath = path.join(dir, entry.name).replaceAll(path.sep, "/").replace(/^\.\//, "");
    if (skipDirs.has(entry.name) || [...skipDirs].some((skip) => relPath === skip || relPath.startsWith(`${skip}/`))) continue;
    if (entry.isDirectory()) {
      files.push(...await walk(relPath, { skipDirs, extensions }));
      continue;
    }
    if (entry.isFile() && (!extensions || extensions.has(path.extname(entry.name)))) files.push(relPath);
  }
  return files;
}

async function assertNoPrivateArtifacts() {
  const files = await walk(".");
  const hits = [];
  for (const file of files) {
    if (file === "scripts/oss-boundary-check.mjs") continue;
    const text = await readText(file).catch(() => "");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const { name, pattern } of forbiddenPatterns) {
        if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${name}`);
      }
    });
  }
  if (hits.length) throw new Error(`OSS boundary private artifact scan failed:\n${hits.join("\n")}`);
  return files.length;
}

// Secret scan covers every text file, including test fixtures. Findings
// report file, line and pattern name only, never the matched value. The
// optional private denylist (see oss-private-denylist.mjs) runs on the same files.
async function assertNoSecrets() {
  const denylist = await loadDenylist(process.env, { repoRoot });
  const skipDirs = new Set([...generatedDirs].filter((dir) => dir !== "test"));
  const files = await walk(".", { skipDirs, extensions: null });
  const hits = [];
  const denied = [];
  for (const file of files) {
    const data = await fs.readFile(path.join(repoRoot, file)).catch(() => null);
    if (!data || data.length > 2 * 1024 * 1024 || data.includes(0)) continue;
    const text = data.toString("utf8");
    for (const { line, name } of scanText(text)) hits.push(`${file}:${line}: ${name}`);
    for (const { line, entry } of scanDenylist(text, denylist.entries)) denied.push(`${file}:${line}: private denylist entry #${entry}`);
  }
  if (hits.length) throw new Error(`OSS boundary secret scan failed:\n${hits.join("\n")}`);
  if (denied.length) throw new Error(`OSS boundary private denylist scan failed:\n${denied.join("\n")}`);
  return denylist.entries.length;
}

async function main() {
  await assertRequiredFiles();
  await assertRequiredText();
  const scanned = await assertNoPrivateArtifacts();
  const denylistEntries = await assertNoSecrets();
  const denylistNote = denylistEntries ? `, ${denylistEntries} private denylist entries` : "";
  console.log(`OSS boundary check passed (${scanned} files scanned${denylistNote})`);
}

await main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
