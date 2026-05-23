import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "ROADMAP.md",
  "docs/architecture.md",
  "docs/assets/orkestr-three-screen-demo.png",
  "docs/demo-logs/coding-agent-first-run.md",
  "examples/coding-agent-demo/README.md",
  ".github/workflows/ci.yml",
  ".github/pull_request_template.md",
];

const scanPatterns = [
  { name: "private host placeholder", pattern: /private-(?:domain|host)|real-chat-id/i },
  { name: "OpenAI key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Google OAuth secret", pattern: /GOCSPX-[A-Za-z0-9_-]{10,}/ },
  { name: "machine path", pattern: /\/home\/openclaw|\/root\// },
  { name: "tailnet host", pattern: /[a-z0-9-]+\.ts\.net/i },
  { name: "tailscale ip", pattern: /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
];

const scanSkips = new Set([
  "node_modules",
  "dist",
  ".git",
  ".angular",
  ".orkestr",
]);

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n== ${label} ==`);
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ORKESTR_BROWSER_LAUNCH_DISABLED: process.env.ORKESTR_BROWSER_LAUNCH_DISABLED || "1",
      },
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

async function assertRequiredFiles() {
  console.log("\n== required launch files ==");
  for (const file of requiredFiles) {
    const stat = await fs.stat(path.join(repoRoot, file)).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`Missing required launch file: ${file}`);
    if (/\.(?:gif|png|svg)$/.test(file) && stat.size > 5 * 1024 * 1024) {
      throw new Error(`${file} is too large for README use`);
    }
    console.log(`ok ${file}`);
  }
}

async function walk(dir, files = []) {
  const entries = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if ([...scanSkips].some((skip) => rel === skip || rel.startsWith(`${skip}/`))) continue;
    if (entry.isDirectory()) await walk(rel, files);
    else if (/\.(?:js|mjs|ts|html|css|md|json|yml|yaml|sh|svg)$/.test(entry.name)) files.push(rel);
  }
  return files;
}

async function privacyScan() {
  console.log("\n== privacy scan ==");
  const files = await walk(".");
  const hits = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(repoRoot, file), "utf8").catch(() => "");
    const lines = raw.split("\n");
    lines.forEach((line, index) => {
      for (const { name, pattern } of scanPatterns) {
        if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${name}`);
      }
    });
  }
  const allowed = hits.filter((hit) =>
    hit.startsWith("docs/alpha-release.md:") ||
    hit.startsWith("scripts/launch-check.mjs:") ||
    hit.startsWith("test/gmail.test.js:") ||
    hit.startsWith("packages/connectors/src/gmail.js:"),
  );
  const failures = hits.filter((hit) => !allowed.includes(hit));
  if (failures.length) throw new Error(`Privacy scan failed:\n${failures.join("\n")}`);
  console.log(`ok ${files.length} files scanned (${allowed.length} known benign hits)`);
}

async function main() {
  await assertRequiredFiles();
  await privacyScan();
  await run("npm", ["run", "check"], "npm run check");
  await run("npm", ["run", "smoke"], "npm run smoke");
  await run("npm", ["run", "demo:coding-agent"], "npm run demo:coding-agent");
  console.log("\nLaunch check passed");
}

await main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
