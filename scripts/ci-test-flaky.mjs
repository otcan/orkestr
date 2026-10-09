// Retry-once policy for test files explicitly listed in test/flaky-tests.json.
// A run is retried only when every failure belongs to a listed file; any other
// failure (or one that cannot be attributed to a file) fails CI immediately.
// Tests that pass on retry are reported, never hidden.
import fs from "node:fs";
import path from "node:path";

export const flakyManifestPath = "test/flaky-tests.json";

export function loadFlakyManifest(root = process.cwd()) {
  const file = path.join(root, flakyManifestPath);
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, "utf8")).tests;
  if (!Array.isArray(entries)) throw new Error(`${flakyManifestPath}: "tests" must be an array`);
  return entries.map((entry) => {
    const testFile = String(entry?.file || "").trim();
    const reason = String(entry?.reason || "").trim();
    if (!/^test\/.+\.test\.js$/u.test(testFile) || !reason) {
      throw new Error(`${flakyManifestPath}: every entry needs a test/*.test.js "file" and a "reason"`);
    }
    return { file: testFile, reason };
  });
}

function failureFile(failure, flakyFiles) {
  if (failure.file) return failure.file.split(path.sep).join("/");
  // File-level failures (crash, timeout) are reported under the file path.
  return flakyFiles.find((file) => failure.name === file || failure.name.endsWith(`/${file}`)) || "";
}

// Returns the flaky files to rerun, or [] when the failures must not be retried.
export function planFlakyRetry(failures = [], manifest = []) {
  const flakyFiles = manifest.map((entry) => entry.file);
  if (!failures.length || !flakyFiles.length) return [];
  const files = failures.map((failure) => failureFile(failure, flakyFiles));
  if (!files.every((file) => flakyFiles.includes(file))) return [];
  return [...new Set(files)].sort();
}

export function flakyReport({ retried = [], passed = false, manifest = [] } = {}) {
  const reasons = new Map(manifest.map((entry) => [entry.file, entry.reason]));
  return [
    `### Flaky test report: ${retried.length} file(s) retried once, ${passed ? "passed on retry" : "failed again"}`,
    "",
    "| File | Reason it is marked flaky |",
    "| --- | --- |",
    ...retried.map((file) => `| ${file} | ${String(reasons.get(file) || "").replace(/\|/g, "\\|")} |`),
    "",
  ].join("\n");
}

export function publishFlakyReport(report, { env = process.env, log = console } = {}) {
  log.log(report);
  if (env.GITHUB_ACTIONS === "true") log.log(`::warning title=Flaky tests retried::${report.split("\n")[0].replace(/^#+\s*/u, "")}`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
