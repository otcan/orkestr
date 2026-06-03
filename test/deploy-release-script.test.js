import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("release deploy script exposes versioned install, status, and rollback", async () => {
  const script = await fs.readFile("scripts/deploy-git-release.sh", "utf8");
  const manifest = await fs.readFile("scripts/release-manifest.mjs", "utf8");
  const { stdout } = await execFileAsync("bash", ["scripts/deploy-git-release.sh", "--help"]);

  await execFileAsync("bash", ["-n", "scripts/deploy-git-release.sh"]);
  await execFileAsync("node", ["--check", "scripts/release-manifest.mjs"]);
  await execFileAsync("bash", ["scripts/deploy-git-release.sh", "--check-only"]);

  assert.match(stdout, /install \[--ref REF\]/);
  assert.match(stdout, /--allow-untagged\|--require-tagged/);
  assert.match(stdout, /--no-backup/);
  assert.match(stdout, /--sync-workers\|--no-sync-workers/);
  assert.match(stdout, /--no-interrupt\|--allow-interrupt/);
  assert.match(stdout, /--wait-active/);
  assert.match(stdout, /--active-timeout SECONDS/);
  assert.match(stdout, /rollback \[--to RELEASE_ID\]/);
  assert.match(script, /ORKESTR_RELEASES_DIR/);
  assert.match(script, /ORKESTR_CURRENT_LINK/);
  assert.match(script, /ORKESTR_DEPLOY_HISTORY/);
  assert.match(script, /release-manifest\.json/);
  assert.match(script, /bash scripts\/install-runtime-deps\.sh/);
  assert.match(script, /npm --prefix "\$release_dir" run build:runtime/);
  assert.match(script, /npm --prefix "\$release_dir" run smoke/);
  assert.match(script, /backup_state/);
  assert.match(script, /ORKESTR_DEPLOY_BACKUP_STATE/);
  assert.match(script, /ORKESTR_DEPLOY_BACKUP_EXCLUDES/);
  assert.match(script, /backup_excludes="\$\{ORKESTR_DEPLOY_BACKUP_EXCLUDES:-run tmp whatsapp-bridge\/sessions\}"/);
  assert.match(script, /--exclude="\$data_base\/\$exclude"/);
  assert.match(script, /ORKESTR_DEPLOY_SYNC_WORKERS/);
  assert.match(script, /sync_safe_workers_after_deploy/);
  assert.match(script, /syncSafeThreadWorkersWithParents/);
  assert.match(script, /Post-deploy worker sync/);
  assert.match(script, /backup_state_arg/);
  assert.match(script, /health_check/);
  assert.match(script, /health_check "\$health_url" 40\s+deploy_public_exposure_check/);
  assert.match(script, /ORKESTR_DEPLOY_EXPOSURE_CHECK/);
  assert.match(script, /ORKESTR_DEPLOY_PUBLIC_BASE_URL/);
  assert.match(script, /ORKESTR_DEPLOY_EXPOSURE_PRIVATE_PATHS/);
  assert.match(script, /exposure_check="\$\(bool_value "\$\{ORKESTR_DEPLOY_EXPOSURE_CHECK:-1\}"\)"/);
  assert.match(script, /\/api\/threads \/api\/users \/api\/timers \/api\/browser-sessions \/api\/desktops\/leases \/api\/connectors \/api\/whereiam/);
  assert.match(script, /Public exposure check failed: unauthenticated/);
  assert.match(script, /expected 401/);
  assert.match(script, /blocked_count/);
  assert.match(script, /\^0\+\$/);
  assert.match(script, /blocked by TLS\/network/);
  assert.match(script, /sync_versioned_env/);
  assert.match(script, /set_env_assignment ORKESTR_APP_DIR "\$current_link"/);
  assert.match(script, /set_env_assignment ORKESTR_RELEASE_DEPLOY "1"/);
  assert.match(script, /repair_env_file_permissions/);
  assert.match(script, /if \[ "\$run_user" != "root" \]/);
  assert.match(script, /chown "root:\$run_group" "\$env_file_path"/);
  assert.match(script, /chmod 0640 "\$env_file_path"/);
  assert.match(script, /repair_runtime_ownership/);
  assert.match(script, /systemctl show -p MainPID --value/);
  assert.match(script, /ps -o user= -p "\$main_pid"/);
  assert.match(script, /echo "\$\{user:-root\}"/);
  assert.match(script, /codex_home="\$\{CODEX_HOME:-\$runtime_home\/codex\}"/);
  assert.match(script, /chown -R "\$run_user:\$run_group" "\$codex_home"/);
  assert.match(script, /chmod 0700 "\$codex_home"/);
  assert.match(script, /ORKESTR_DEPLOY_TAGS_ONLY/);
  assert.match(script, /ORKESTR_DEPLOY_NO_INTERRUPT/);
  assert.match(script, /ORKESTR_DEPLOY_WAIT_ACTIVE/);
  assert.match(script, /ORKESTR_DEPLOY_ACTIVE_CHECK_URL/);
  assert.match(script, /ORKESTR_DEPLOY_DRAIN_FILE/);
  assert.match(script, /ORKESTR_SERVICE_TIMEOUT_STOP_SEC/);
  assert.match(script, /deploy_guard_active_work/);
  assert.match(script, /begin_deploy_drain/);
  assert.match(script, /service_is_active/);
  assert.match(script, /active_thread_hard_count/);
  assert.match(script, /active_thread_unsafe_count/);
  assert.match(script, /codex_app_server_external_enabled/);
  assert.match(script, /ORKESTR_CODEX_APP_SERVER_SOCKET/);
  assert.match(script, /target_release_supports_external_codex_app_server/);
  assert.match(script, /ensure_codex_app_server_split_for_target/);
  assert.match(script, /write_codex_app_server_main_service_dropin/);
  assert.match(script, /60-codex-app-server\.conf/);
  assert.match(script, /Environment=ORKESTR_CODEX_APP_SERVER_MODE=external/);
  assert.match(script, /\/usr\/local\/bin\/orkestr-codex-app-server/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr-codex-app-server/);
  assert.match(script, /codexAppServerTransport/);
  assert.match(script, /appServerTransport/);
  assert.match(script, /deploy_guard_before_restart/);
  assert.match(script, /configure_service_shutdown_timeout/);
  assert.match(script, /45-direct-node\.conf/);
  assert.match(script, /ExecStart=\$node_bin dist\/server\/apps\/server\/src\/server\.js/);
  assert.match(script, /50-shutdown-timeout\.conf/);
  assert.match(script, /TimeoutStopSec=\$timeout/);
  assert.match(script, /KillMode=mixed/);
  assert.match(script, /Deploy drain active: new inputs will queue/);
  assert.match(script, /Deploy drain cleared after \$\{service_name\}\.service passed health checks/);
  assert.match(script, /service-local child processes are reaped after the stop timeout/);
  assert.match(script, /ORKESTR_CODEX_APP_SERVER_MODE/);
  assert.match(script, /ORKESTR_CODEX_APP_SERVER_SERVICE_NAME/);
  assert.match(script, /tags_only_arg/);
  assert.match(script, /--allow-untagged\|--allow-untagged-releases/);
  assert.match(script, /--require-tagged\|--require-tagged-releases/);
  assert.match(script, /if \[ ! -e "\$release_dir\/\.git" \]/);
  assert.match(script, /worktree add --detach/);
  assert.match(script, /LC_ALL=C tr -c 'A-Za-z0-9\._\+-' '-'/);
  assert.match(manifest, /schemaVersion/);
  assert.match(manifest, /compatibility/);
});

test("release manifest generator records git and component metadata", async () => {
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-manifest-")), "release.json");
  await execFileAsync("node", [
    "scripts/release-manifest.mjs",
    "--output",
    output,
    "--ref",
    "v0.1.7",
    "--channel",
    "production",
    "--release-id",
    "v0.1.7-test",
    "--repo",
    "https://github.com/otcan/orkestr.git",
    "--commit",
    "f0c1538c3596acae8d7535c29a6c1fe90e53c64a",
    "--tag",
    "v0.1.7",
    "--describe",
    "v0.1.7-0-gf0c1538",
  ]);

  const manifest = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.releaseId, "v0.1.7-test");
  assert.equal(manifest.channel, "production");
  assert.equal(manifest.source.requestedRef, "v0.1.7");
  assert.equal(manifest.git.commit, "f0c1538c3596acae8d7535c29a6c1fe90e53c64a");
  assert.equal(manifest.git.tag, "v0.1.7");
  assert.equal(manifest.components.orkestr.commit, "f0c1538c3596acae8d7535c29a6c1fe90e53c64a");
  assert.equal(manifest.compatibility.stateSchema, 1);
});
