import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scannerRelease, scannerLogOptions } from "../scripts/security/secret-scan.mjs";
import { scanEnvironment } from "../scripts/security/secret-scan-scope.mjs";

const binary = process.env.ORKESTR_TEST_GITLEAKS_BINARY;
const config = fileURLToPath(new URL("../scripts/security/gitleaks.toml", import.meta.url));
const lifetimeDigest = "4632be4e94cef92a0b8a2970bad0a55a1925d07d7926eb05a6af32ef512954d7";
const manifests = ["codex", "claude"].map(kind => `v2/provider-broker/${kind}-package.json`);
const entry = value => `  "reaping.py": "${value}"`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-digest-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const repository = path.join(root, "repo");
  await fs.mkdir(repository);
  const git = args => {
    const result = spawnSync("git", ["-C", repository, "-c", "user.name=Example Test",
      "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args],
    { env: scanEnvironment, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, "isolated fixture Git command failed");
    return result.stdout.trim();
  };
  git(["init", "--quiet", "--template="]);
  const version = spawnSync(binary, ["version"], { env: scanEnvironment, encoding: "utf8", timeout: 10000 });
  assert.equal(version.status, 0, "scanner version unavailable");
  assert.equal(version.stdout.trim().replace(/^v/, ""), scannerRelease.version);
  const ignore = path.join(root, "empty-ignore");
  const defaults = path.join(root, "defaults.toml");
  await fs.writeFile(ignore, "", { mode: 0o600 });
  await fs.writeFile(defaults, "[extend]\nuseDefault = true\n", { mode: 0o600 });
  let iteration = 0;
  return {
    defaults,
    async write(files) {
      for (const [name, text] of Object.entries(files)) {
        const target = path.join(repository, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, text + "\n", { mode: 0o600 });
      }
      git(["add", "."]);
      git(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Synthetic scanner fixtures"]);
    },
    async scan(policy = config) {
      const report = path.join(root, `redacted-${iteration++}.json`);
      const result = spawnSync(binary, ["git", repository, "--config", policy,
        "--ignore-gitleaks-allow", "--gitleaks-ignore-path", ignore,
        "--log-opts", scannerLogOptions({ commits: [git(["rev-parse", "HEAD"])] }),
        "--redact=100", "--no-banner", "--no-color", "--report-format", "json",
        "--report-path", report, "--exit-code", "23", "--timeout", "30"],
      { env: scanEnvironment, cwd: repository, stdio: "ignore", timeout: 35000 });
      assert.ok([0, 23].includes(result.status), "pinned scanner did not complete");
      const raw = JSON.parse(await fs.readFile(report, "utf8"));
      await fs.rm(report);
      const locations = raw.map(row => ({ path: row.File, rule: row.RuleID, line: row.StartLine }));
      assert.equal(result.status === 0, locations.length === 0);
      return locations;
    },
  };
}

test("pinned scanner exempts only the reviewed digest in both exact inventories", { skip: !binary }, async t => {
  const peer = await fixture(t);
  await peer.write(Object.fromEntries(manifests.map(name => [name, `{\n${entry(lifetimeDigest)}\n}`])));
  const before = await peer.scan(peer.defaults);
  assert.deepEqual(before.map(row => row.path).sort(), [...manifests].sort(), "fixture must reproduce both false positives");
  assert.ok(before.every(row => row.rule === "generic-api-key"));
  assert.deepEqual(await peer.scan(), []);
});

test("credentials and the same digest outside the exact entry remain detectable", { skip: !binary }, async t => {
  const peer = await fixture(t);
  // These random test values have credential syntax but no account authority.
  const syntheticValue = randomBytes(32).toString("hex");
  const providerValue = ["gh", "p_", randomBytes(18).toString("hex")].join("");
  const files = Object.fromEntries(manifests.map(name => [name,
    `{\n${entry(lifetimeDigest)},\n  "api_key": "${syntheticValue}",\n  "token": "${providerValue}"\n}`]));
  files["outside.json"] = `{\n${entry(lifetimeDigest)},\n  "api_key": "${syntheticValue}"\n}`;
  files["nested/" + manifests[0]] = `{\n${entry(lifetimeDigest)}\n}`;
  files[manifests[1] + ".bak"] = `{\n${entry(lifetimeDigest)}\n}`;
  await peer.write(files);
  const found = await peer.scan();
  for (const name of [...manifests, "outside.json"]) {
    assert.ok(found.some(row => row.path === name && row.rule === "generic-api-key" && row.line === 3),
      `credential-shaped fixture must remain detected in ${name}`);
  }
  for (const name of manifests) assert.ok(found.some(row => row.path === name && row.rule === "github-pat"));
  for (const name of ["outside.json", "nested/" + manifests[0], manifests[1] + ".bak"])
    assert.ok(found.some(row => row.path === name && row.rule === "generic-api-key" && row.line === 2));
  assert.ok(!found.some(row => manifests.includes(row.path) && row.line === 2));
});

test("arbitrary hashes and altered entry contexts are never exempt", { skip: !binary }, async t => {
  const peer = await fixture(t);
  await peer.write({ [manifests[0]]: `{\n${entry(randomBytes(32).toString("hex"))}\n}`,
    [manifests[1]]: `{\n  "api_key": "${lifetimeDigest}"\n}` });
  const found = await peer.scan();
  assert.deepEqual(found.map(row => row.path).sort(), [...manifests].sort());
  assert.ok(found.every(row => row.rule === "generic-api-key"));
  await peer.write({ [manifests[0]]: `{ ${entry(lifetimeDigest)}, "api_key": "${randomBytes(32).toString("hex")}" }` });
  const later = await peer.scan();
  assert.ok(later.some(row => row.path === manifests[0] && row.line === 1 && row.rule === "generic-api-key"));
});
