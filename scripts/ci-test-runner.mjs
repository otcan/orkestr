import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--test", "--test-concurrency=1"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

const chunks = [];

function collect(chunk) {
  chunks.push(Buffer.from(chunk));
}

child.stdout.on("data", collect);
child.stderr.on("data", collect);

const exitCode = await new Promise((resolve) => {
  child.on("close", resolve);
});

const output = Buffer.concat(chunks).toString("utf8");
const lines = output.split(/\r?\n/);
const failedIndices = lines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => /^not ok \d+ - /.test(line))
  .map(({ index }) => index);

if (exitCode === 0) {
  const summaryStart = Math.max(
    lines.findIndex((line) => /^1\.\.\d+/.test(line)),
    lines.length - 20,
  );
  console.log(lines.slice(summaryStart).join("\n").trimEnd());
  process.exit(0);
}

console.error("CI test run failed. Showing failing TAP blocks and summary.");

if (failedIndices.length > 0) {
  const printed = new Set();
  for (const index of failedIndices) {
    const start = Math.max(0, index - 12);
    const end = Math.min(lines.length, index + 45);
    for (let i = start; i < end; i += 1) printed.add(i);
  }
  for (const index of [...printed].sort((a, b) => a - b)) {
    console.error(lines[index]);
  }
} else {
  console.error("No explicit TAP failure block was found.");
}

const summaryStart = Math.max(
  lines.findIndex((line) => /^1\.\.\d+/.test(line)),
  lines.length - 80,
);
console.error("\nTAP summary tail:");
console.error(lines.slice(summaryStart).join("\n").trimEnd());

process.exit(exitCode ?? 1);
