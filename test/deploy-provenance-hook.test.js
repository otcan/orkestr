// Shell-level coverage for the release provenance hook in
// scripts/deploy-git-release.sh: the real install_command/rollback_command
// bodies run against stubbed host helpers and a loopback fake GitHub API.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SHA, githubRoutes, artifact, passingRuns } from "./helpers/release-provenance-fixtures.mjs";

const execFileAsync = promisify(execFile);
const deployScript = await fs.readFile("scripts/deploy-git-release.sh", "utf8");

function extract(name) {
  const body = deployScript.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m"))?.[0];
  assert.ok(body, `missing ${name}`);
  return body;
}

async function fakeGithub(routes) {
  const server = http.createServer((request, response) => {
    const route = routes[new URL(request.url, "http://127.0.0.1").pathname];
    if (route === undefined) { response.writeHead(404).end("{}"); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const stubs = `
prune_release_directories() { :; }
prepare_repo_cache() { :; }
make_release_runtime_readable() { :; }
repair_runtime_ownership() { :; }
restart_and_verify_public_service() { :; }
restart_and_verify_mailbox_mta() { :; }
sync_standalone_connectors_release() { :; }
cleanup_incomplete_release() { :; }
deploy_guard_before_restart() { :; }
ensure_codex_app_server_split_for_target() { :; }
sync_versioned_env() { :; }
send_release_whatsapp_notifications() { :; }
sync_safe_workers_after_deploy() { :; }
release_train_instance_fanout() { :; }
verify_required_whatsapp_accounts() { :; }
restart_and_verify() { :; }
backup_state() { echo ""; }
activate_release() { echo "$1" > "$MARKERS/activated"; }
current_release_id() { echo "\${CURRENT_RELEASE:-}"; }
resolve_target_ref() { echo "${SHA}"; }
npm() { :; }
git() {
  case "$3 $4" in
    "worktree add")
      mkdir -p "$6/scripts" "$6/dist/server"
      echo "console.log(1)" > "$6/dist/server/app.js"
      echo "exit 0" > "$6/scripts/install-runtime-deps.sh"
      printf '%s\\n' 'const i = process.argv.indexOf("--output"); process.getBuiltinModule("node:fs").writeFileSync(process.argv[i + 1], JSON.stringify({ schemaVersion: 1, releaseId: "stub" }));' > "$6/scripts/release-manifest.mjs"
      touch "$MARKERS/built"
      ;;
    "rev-parse HEAD") echo "${SHA}" ;;
    *) return 1 ;;
  esac
}
`;

async function harness(command, { env = {}, scriptDir = path.resolve("scripts"), setup } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-prov-hook-"));
  const markers = path.join(root, "markers");
  await fs.mkdir(markers);
  await fs.mkdir(path.join(root, "releases"));
  if (setup) await setup(root);
  const source = [
    "set -euo pipefail",
    ...["sanitize_id", "release_is_complete", "write_history_event", "provenance_gate", "install_command", "rollback_command", "cleanup_deploy_on_exit"].map(extract),
    "cleanup_deploy_drain_on_exit() { :; }",
    stubs,
    `script_dir=${JSON.stringify(scriptDir)}`,
    `releases_dir=${JSON.stringify(path.join(root, "releases"))}`,
    `repo_cache=${JSON.stringify(path.join(root, "cache"))}`,
    `deploy_history=${JSON.stringify(path.join(root, "deployments.json"))}`,
    'deploy_ref=main; deploy_channel=main; tags_only_arg=0; run_smoke=0; service_name=orkestr; to_release="${TO_RELEASE:-}"',
    "repo_url=git@github.com:example-org/example-repo.git",
    'provenance_file=""; staging_release_dir=""; provenance_rejected_exit_code=77',
    "trap cleanup_deploy_on_exit EXIT",
    command,
  ].join("\n");
  let result;
  try {
    result = { ...(await execFileAsync("bash", ["-c", source], { env: { PATH: process.env.PATH, TMPDIR: root, MARKERS: markers, ...env } })), code: 0 };
  } catch (error) {
    result = error;
  }
  const exists = async (file) => fs.access(file).then(() => true, () => false);
  const history = await fs.readFile(path.join(root, "deployments.json"), "utf8").then(JSON.parse, () => []);
  return { ...result, root, history, built: await exists(path.join(markers, "built")), activated: await exists(path.join(markers, "activated")), gateRan: await exists(path.join(markers, "gate-ran")) };
}

test("install hook rejects failed checks in enforce mode before building or activating", async () => {
  const api = await fakeGithub(githubRoutes({ checkRuns: passingRuns({ build: { conclusion: "failure" } }), artifacts: [] }));
  try {
    const result = await harness("install_command", { env: { ORKESTR_GITHUB_API_URL: api.url } });
    assert.equal(result.code, 77, result.stderr);
    assert.match(result.stderr, /Release provenance gate rejected/);
    assert.match(result.stderr, /Refusing to build or activate/);
    assert.equal(result.built, false);
    assert.equal(result.activated, false);
    assert.equal(result.history.at(-1).status, "rejected");
    assert.equal(result.history.at(-1).error, "provenance_gate_rejected");
    assert.equal(result.history.at(-1).provenance.gate.result, "rejected");
    assert.deepEqual(await fs.readdir(result.root).then((names) => names.filter((name) => name.startsWith("orkestr-provenance"))), [], "temporary record is removed");
  } finally {
    await api.close();
  }
});

test("install hook records provenance in the release manifest and history on success", async () => {
  const api = await fakeGithub(githubRoutes({ artifacts: [artifact("runtime-dist", { id: 11, digest: `sha256:${"c".repeat(64)}` })] }));
  try {
    const result = await harness("install_command", { env: { ORKESTR_GITHUB_API_URL: api.url } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.built, true);
    assert.equal(result.activated, true);
    const event = result.history.at(-1);
    assert.equal(event.status, "success");
    assert.equal(event.provenanceSource, "deploy-gate");
    assert.equal(event.provenance.gate.result, "passed");
    assert.equal(event.provenance.ci.runId, "900");
    assert.equal(event.provenance.ci.checks.find((check) => check.name === "build").conclusion, "success");
    assert.equal(event.provenance.artifact.runtime.digest, `sha256:${"c".repeat(64)}`);
    assert.equal(event.provenance.attestation.status, "attestation_present_unverified");
    assert.match(event.provenance.installedTree.dist.treeDigest, /^sha256:[a-f0-9]{64}$/);
    const releaseDir = path.join(result.root, "releases", `main-${SHA.slice(0, 12)}`);
    const manifest = JSON.parse(await fs.readFile(path.join(releaseDir, "release-manifest.json"), "utf8"));
    assert.equal(manifest.releaseId, "stub");
    assert.deepEqual(manifest.provenance.installedTree, event.provenance.installedTree);
  } finally {
    await api.close();
  }
});

test("install hook continues with a warning when checks fail in warn mode", async () => {
  const api = await fakeGithub(githubRoutes({ checkRuns: passingRuns({ smoke: { status: "in_progress" } }), artifacts: [] }));
  try {
    const result = await harness("install_command", { env: { ORKESTR_GITHUB_API_URL: api.url, ORKESTR_DEPLOY_REQUIRE_CHECKS: "warn" } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Release provenance warning/);
    assert.equal(result.activated, true);
    assert.equal(result.history.at(-1).provenance.gate.result, "warned");
  } finally {
    await api.close();
  }
});

test("rollback reuses an accepted release and never runs the provenance gate", async () => {
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-prov-gate-stub-"));
  await fs.mkdir(path.join(scriptDir, "release-provenance"));
  await fs.writeFile(path.join(scriptDir, "release-provenance", "deploy-gate.mjs"), 'process.getBuiltinModule("node:fs").writeFileSync(process.env.MARKERS + "/gate-ran", "1"); process.exit(77);\n');
  const result = await harness("rollback_command", {
    scriptDir,
    env: { TO_RELEASE: "main-previous", ORKESTR_DEPLOY_REQUIRE_CHECKS: "enforce", ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "enforce" },
    setup: async (root) => {
      const dir = path.join(root, "releases", "main-previous");
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "release-manifest.json"), JSON.stringify({ releaseId: "main-previous", provenance: { gate: { result: "passed" }, ci: { runId: "700" } } }));
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.gateRan, false);
  assert.equal(result.activated, true);
  const event = result.history.at(-1);
  assert.equal(event.status, "rollback");
  assert.equal(event.provenanceSource, "release-manifest");
  assert.equal(event.provenance.ci.runId, "700");
  assert.doesNotMatch(extract("rollback_command"), /provenance_gate/);
});

test("deployer gates after resolving the exact commit and before building and activating", () => {
  const install = extract("install_command");
  const order = ["resolve_target_ref", "provenance_gate pre", "worktree add", "provenance_gate post", "activate_release"].map((needle) => install.indexOf(needle));
  assert.ok(order.every((index) => index > 0), order.join(","));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(deployScript, /gate="\$script_dir\/release-provenance\/deploy-gate\.mjs"/);
  assert.match(deployScript, /ORKESTR_DEPLOY_REQUIRE_CHECKS/);
  assert.match(deployScript, /ORKESTR_DEPLOY_ARTIFACT_PROVENANCE/);
});
