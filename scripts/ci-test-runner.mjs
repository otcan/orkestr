import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function clean(value = "") {
  return String(value || "").trim();
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function flagValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? clean(argv[index + 1]) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

export function discoverTestFiles(root = process.cwd()) {
  const testRoot = path.join(root, "test");
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (/\.test\.js$/u.test(entry.name)) files.push(path.relative(root, fullPath));
    }
  }
  walk(testRoot);
  return files.sort();
}

export function normalizeShard({ index = "1", total = "1", zeroBased = false } = {}) {
  const shardTotal = positiveInteger(total, 1);
  const rawIndex = clean(index || (zeroBased ? "0" : "1"));
  const parsedIndex = Number(rawIndex);
  if (!Number.isFinite(parsedIndex)) {
    throw new Error(`Invalid test shard index: ${rawIndex}`);
  }
  const inferredZeroBased = zeroBased || rawIndex === "0";
  const shardIndex = inferredZeroBased ? Math.floor(parsedIndex) : Math.floor(parsedIndex) - 1;
  if (shardIndex < 0 || shardIndex >= shardTotal) {
    throw new Error(`Invalid test shard index ${rawIndex} for total ${shardTotal}`);
  }
  return { index: shardIndex, total: shardTotal, displayIndex: shardIndex + 1 };
}

export function selectShardFiles(files = [], shard = { index: 0, total: 1 }) {
  if (!shard || shard.total <= 1) return [...files];
  return files.filter((_, index) => index % shard.total === shard.index);
}

export function parseCiTestRunnerArgs(argv = process.argv.slice(2), env = process.env) {
  const ciNodeIndex = clean(env.CI_NODE_INDEX);
  const explicitShardIndex = clean(env.ORKESTR_TEST_SHARD_INDEX);
  const shard = normalizeShard({
    index: flagValue(argv, "--shard-index", clean(explicitShardIndex || ciNodeIndex || "1")),
    total: flagValue(argv, "--shard-total", clean(env.ORKESTR_TEST_SHARD_TOTAL || env.CI_NODE_TOTAL || "1")),
    zeroBased: hasFlag(argv, "--shard-zero-based") ||
      truthy(env.ORKESTR_TEST_SHARD_ZERO_BASED) ||
      (!explicitShardIndex && Boolean(ciNodeIndex)),
  });
  return {
    plan: hasFlag(argv, "--plan"),
    root: path.resolve(flagValue(argv, "--root", process.cwd())),
    concurrency: positiveInteger(flagValue(argv, "--concurrency", clean(env.ORKESTR_TEST_CONCURRENCY || "1")), 1),
    forceExit: env.ORKESTR_TEST_FORCE_EXIT !== "0",
    shard,
  };
}

export function buildNodeTestArgs(options = {}, files = []) {
  const testArgs = ["--test", `--test-concurrency=${positiveInteger(options.concurrency, 1)}`];
  if (options.forceExit !== false) {
    // The full suite starts short-lived HTTP and runtime monitors in several
    // tests. On some hosts Node keeps an already-finished test process alive for
    // leaked handles, so the CI wrapper exits after the test runner completes.
    testArgs.push("--test-force-exit");
  }
  testArgs.push(...files);
  return testArgs;
}

function summaryStartIndex(lines, tail) {
  const tapPlanIndex = lines.findIndex((line) => /^1\.\.\d+/u.test(line));
  return Math.max(tapPlanIndex, lines.length - tail);
}

export async function runCiTests(options = parseCiTestRunnerArgs()) {
  const allFiles = discoverTestFiles(options.root);
  const files = selectShardFiles(allFiles, options.shard);
  const testArgs = buildNodeTestArgs(options, options.shard.total > 1 ? files : []);

  if (options.plan) {
    return {
      ok: true,
      root: options.root,
      shard: options.shard,
      concurrency: options.concurrency,
      totalFiles: allFiles.length,
      selectedFiles: files,
      nodeArgs: testArgs,
    };
  }

  if (options.shard.total > 1) {
    console.log(`Running test shard ${options.shard.displayIndex}/${options.shard.total}: ${files.length}/${allFiles.length} files`);
  }
  if (options.shard.total > 1 && files.length === 0) {
    console.log("No tests selected for this shard.");
    return { ok: true, code: 0 };
  }

  const child = spawn(process.execPath, testArgs, {
    cwd: options.root,
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
    .filter(({ line }) => /^not ok \d+ - /u.test(line))
    .map(({ index }) => index);

  if (exitCode === 0) {
    console.log(lines.slice(summaryStartIndex(lines, 20)).join("\n").trimEnd());
    return { ok: true, code: 0 };
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

  console.error("\nTAP summary tail:");
  console.error(lines.slice(summaryStartIndex(lines, 80)).join("\n").trimEnd());

  return { ok: false, code: exitCode ?? 1 };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runCiTests(parseCiTestRunnerArgs())
    .then((result) => {
      if (result.selectedFiles) {
        console.log(JSON.stringify(result, null, 2));
      }
      if (!result.ok) process.exitCode = result.code || 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 2;
    });
}
