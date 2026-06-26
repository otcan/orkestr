import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  { name: "OpenAI live key", pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google OAuth live secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{10,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "numeric WhatsApp id", pattern: /\b\d{10,}@(c\.us|g\.us|lid)\b/i },
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

async function walk(dir = ".") {
  const entries = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relPath = path.join(dir, entry.name).replaceAll(path.sep, "/").replace(/^\.\//, "");
    if (generatedDirs.has(entry.name) || [...generatedDirs].some((skip) => relPath === skip || relPath.startsWith(`${skip}/`))) continue;
    if (entry.isDirectory()) {
      files.push(...await walk(relPath));
      continue;
    }
    if (scanExtensions.has(path.extname(entry.name))) files.push(relPath);
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

async function main() {
  await assertRequiredFiles();
  await assertRequiredText();
  const scanned = await assertNoPrivateArtifacts();
  console.log(`OSS boundary check passed (${scanned} files scanned)`);
}

await main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
