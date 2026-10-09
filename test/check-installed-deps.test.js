import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkInstalledDependencies, findInstalledDependencyDrift, formatDependencyDrift } from "../scripts/check-installed-deps.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

test("installed dependency check reports packages that drift from the lockfile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-deps-drift-"));
  await writeJson(path.join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      "node_modules/@scope/builder": { version: "2.0.0" },
      "node_modules/minifier": { version: "1.5.0" },
      "node_modules/minifier/node_modules/nested": { version: "9.9.9" },
      "node_modules/absent-optional": { version: "1.0.0", optional: true },
      "node_modules/absent-required": { version: "1.0.0" },
    },
  });
  await writeJson(path.join(root, "node_modules/@scope/builder/package.json"), { version: "1.9.0" });
  await writeJson(path.join(root, "node_modules/minifier/package.json"), { version: "1.5.0" });

  const drift = findInstalledDependencyDrift(root);

  assert.deepEqual(drift, [
    { name: "@scope/builder", locked: "2.0.0", installed: "1.9.0" },
    { name: "absent-required", locked: "1.0.0", installed: "missing" },
  ]);
  assert.match(formatDependencyDrift(drift), /2 package\(s\)[\s\S]*npm ci/);
});

test("installed dependency check is quiet without a lockfile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-deps-nolock-"));
  assert.deepEqual(findInstalledDependencyDrift(root), []);
});

test("installed dependency check fails only in strict mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-deps-strict-"));
  await writeJson(path.join(root, "package-lock.json"), { lockfileVersion: 3, packages: { "node_modules/tool": { version: "2.0.0" } } });
  await writeJson(path.join(root, "node_modules/tool/package.json"), { version: "1.0.0" });
  const messages = { warn: [], error: [] };
  const log = { warn: (text) => messages.warn.push(text), error: (text) => messages.error.push(text) };

  assert.equal(checkInstalledDependencies({ argv: [], root, log }), 0);
  assert.match(messages.warn[0], /^warning: .*1 package/);
  assert.equal(checkInstalledDependencies({ argv: ["--strict"], root, log }), 1);
  assert.match(messages.error[0], /^error: [\s\S]*tool: installed 1\.0\.0, lockfile 2\.0\.0/);

  await writeJson(path.join(root, "node_modules/tool/package.json"), { version: "2.0.0" });
  assert.equal(checkInstalledDependencies({ argv: ["--strict"], root, log }), 0);
});
