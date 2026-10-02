// Failed-test report for GitHub Actions. Job logs need an authenticated
// GitHub session, but check-run annotations and the step summary are visible
// without one, so failing tests are published there by name, file and line.
import fs from "node:fs";
import path from "node:path";

const MAX_ANNOTATIONS = 10;

function escapeData(value = "") {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value = "") {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// Parses `not ok N - name` TAP blocks into { name, file, line, error }.
export function failedTests(lines = [], root = process.cwd()) {
  const failures = [];
  lines.forEach((line, index) => {
    const match = /^not ok \d+ - (.*)$/u.exec(line);
    if (!match) return;
    const block = lines.slice(index + 1, index + 60);
    const end = block.findIndex((entry) => /^(?:not )?ok \d+ - /u.test(entry));
    const body = end >= 0 ? block.slice(0, end) : block;
    const location = body.map((entry) => /location: '(.+):(\d+):\d+'/u.exec(entry)).find(Boolean);
    const errorIndex = body.findIndex((entry) => /^\s+error: /u.test(entry));
    let error = "";
    if (errorIndex >= 0) {
      const inline = body[errorIndex].replace(/^\s+error:\s*/u, "").replace(/^\|-?$/u, "").replace(/^['"]|['"]$/gu, "");
      error = inline || String(body[errorIndex + 1] || "").trim();
    }
    failures.push({
      name: match[1].trim(),
      file: location ? path.relative(root, location[1]) || location[1] : "",
      line: location ? Number(location[2]) : 0,
      error: error.slice(0, 300),
    });
  });
  return failures;
}

export function failureAnnotations(failures = []) {
  return failures.slice(0, MAX_ANNOTATIONS).map((failure) => {
    const props = [failure.file ? `file=${escapeProperty(failure.file)}` : "", failure.line ? `line=${failure.line}` : "", `title=${escapeProperty("Test failed")}`]
      .filter(Boolean).join(",");
    return `::error ${props}::${escapeData(failure.error ? `${failure.name}: ${failure.error}` : failure.name)}`;
  });
}

export function failureSummaryMarkdown(failures = []) {
  if (!failures.length) return "### Tests failed\n\nNo TAP failure block was found; see the job log.\n";
  const cell = (value) => String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `### ${failures.length} failed test${failures.length === 1 ? "" : "s"}`,
    "",
    "| Test | Location | Error |",
    "| --- | --- | --- |",
    ...failures.map((failure) => `| ${cell(failure.name)} | ${cell(failure.file ? `${failure.file}:${failure.line}` : "")} | ${cell(failure.error)} |`),
    "",
  ].join("\n");
}

// No-op outside GitHub Actions.
export function publishFailedTests(lines = [], { env = process.env, root = process.cwd(), write = (text) => process.stdout.write(text) } = {}) {
  if (env.GITHUB_ACTIONS !== "true") return [];
  const failures = failedTests(lines, root);
  for (const annotation of failureAnnotations(failures)) write(`${annotation}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, failureSummaryMarkdown(failures));
  return failures;
}
