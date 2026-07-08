import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNodeTestArgs,
  discoverTestFiles,
  normalizeShard,
  parseCiTestRunnerArgs,
  selectShardFiles,
} from "../scripts/ci-test-runner.mjs";

test("CI test runner selects deterministic one-based shards", () => {
  const files = [
    "test/a.test.js",
    "test/b.test.js",
    "test/c.test.js",
    "test/d.test.js",
    "test/e.test.js",
  ];

  assert.deepEqual(selectShardFiles(files, normalizeShard({ index: "1", total: "2" })), [
    "test/a.test.js",
    "test/c.test.js",
    "test/e.test.js",
  ]);
  assert.deepEqual(selectShardFiles(files, normalizeShard({ index: "2", total: "2" })), [
    "test/b.test.js",
    "test/d.test.js",
  ]);
});

test("CI test runner accepts zero-based shard indices explicitly", () => {
  assert.deepEqual(normalizeShard({ index: "0", total: "4" }), {
    index: 0,
    total: 4,
    displayIndex: 1,
  });
  assert.throws(() => normalizeShard({ index: "5", total: "4" }), /Invalid test shard index/);
});

test("CI test runner treats CI_NODE_INDEX as zero-based fallback", () => {
  const options = parseCiTestRunnerArgs([], {
    CI_NODE_INDEX: "1",
    CI_NODE_TOTAL: "4",
  });

  assert.deepEqual(options.shard, {
    index: 1,
    total: 4,
    displayIndex: 2,
  });
});

test("CI test runner discovers test files and builds node arguments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ci-runner-"));
  await fs.mkdir(path.join(root, "test", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "test", "b.test.js"), "", "utf8");
  await fs.writeFile(path.join(root, "test", "nested", "a.test.js"), "", "utf8");
  await fs.writeFile(path.join(root, "test", "fixture.js"), "", "utf8");

  const options = parseCiTestRunnerArgs(["--root", root, "--shard-total", "2", "--shard-index", "1", "--concurrency", "3"], {});
  const files = discoverTestFiles(root);
  const args = buildNodeTestArgs(options, selectShardFiles(files, options.shard));

  assert.deepEqual(files, ["test/b.test.js", "test/nested/a.test.js"]);
  assert.equal(options.concurrency, 3);
  assert.deepEqual(args, [
    "--test",
    "--test-concurrency=3",
    "--test-force-exit",
    "test/b.test.js",
  ]);
});
