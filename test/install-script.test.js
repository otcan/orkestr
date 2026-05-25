import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("install script exposes a host-native systemd VPS path", async () => {
  const script = await fs.readFile("scripts/install.sh", "utf8");

  await execFileAsync("bash", ["-n", "scripts/install.sh"]);
  assert.match(script, /--systemd/);
  assert.match(script, /\/opt\/orkestr\/app/);
  assert.match(script, /\/opt\/orkestr\/data/);
  assert.match(script, /\/opt\/orkestr\/workspace/);
  assert.match(script, /\/etc\/orkestr\/orkestr\.env/);
  assert.match(script, /\/usr\/local\/bin\/orkestr/);
  assert.match(script, /\/usr\/local\/bin\/orkestr-update/);
  assert.match(script, /\/usr\/local\/bin\/orkestr-deploy/);
  assert.match(script, /\/usr\/local\/bin\/orkestr-reset-state/);
  assert.match(script, /ORKESTR_RUN_USER=\$run_user/);
  assert.match(script, /scripts\/install\.sh/);
  assert.match(script, /orkestr\.install\.json/);
  assert.match(script, /--config FILE/);
  assert.match(script, /install_json_config_file/);
  assert.match(script, /JSON install config requires Node\.js 22/);
  assert.match(script, /installLocalService: "ORKESTR_INSTALL_LOCAL_SERVICE"/);
  assert.match(script, /codex: \{/);
  assert.match(script, /ORKESTR_INSTALL_MODE/);
  assert.match(script, /ORKESTR_INSTALL_LOCAL_SERVICE/);
  assert.match(script, /ORKESTR_START_AFTER_INSTALL/);
  assert.match(script, /ORKESTR_LOCAL_SERVICE_NAME/);
  assert.match(script, /ORKESTR_LOCAL_SERVICE_LABEL/);
  assert.match(script, /ORKESTR_LOCAL_BIN_DIR/);
  assert.match(script, /advanced: "ORKESTR_INSTALL_ADVANCED"/);
  assert.match(script, /in_orkestr_checkout/);
  assert.match(script, /\[ "\$\{ORKESTR_INSTALL_REEXECED:-0\}" != "1" \] && in_orkestr_checkout/);
  assert.match(script, /run_install_wizard/);
  assert.match(script, /Install Orkestr as a user service/);
  assert.match(script, /Start the Orkestr service after installing/);
  assert.match(script, /This installs Orkestr locally, keeps it private on this machine/);
  assert.match(script, /Default URL: http:\/\/\$host:\$port\/setup/);
  assert.match(script, /Using safe defaults for local URL, folders, service install, and startup/);
  assert.match(script, /Run with --advanced to change them/);
  assert.match(script, /Ask before Codex runs higher-risk commands/);
  assert.match(script, /--advanced/);
  assert.match(script, /ORKESTR_INSTALL_ADVANCED/);
  assert.match(script, /Private bind host/);
  assert.match(script, /ORKESTR_CODEX_SANDBOX/);
  assert.match(script, /ORKESTR_CODEX_APPROVAL_POLICY/);
  assert.match(script, /--profile\)/);
  assert.doesNotMatch(script, /ORKESTR_INSTALL_PROFILE=\$install_profile/);
  assert.match(script, /--profile local-safe\|local-trusted/);
  assert.match(script, /--enable-host-codex/);
  assert.match(script, /--no-service/);
  assert.match(script, /--no-start/);
  assert.match(script, /--fresh/);
  assert.match(script, /ORKESTR_FRESH_INSTALL/);
  assert.match(script, /ORKESTR_INSTALL_REEXECED/);
  assert.match(script, /ORKESTR_INSTALL_TEMP_FILE/);
  assert.match(script, /exec bash "\$install_tmp" "\$@" <\/dev\/tty/);
  assert.match(script, /ORKESTR_NONINTERACTIVE/);
  assert.match(script, /fresh_reset_local_install/);
  assert.match(script, /safe_remove_path/);
  assert.match(script, /ORKESTR_INSTALL_PROFILE/);
  assert.match(script, /ORKESTR_ENABLE_HOST_CODEX/);
  assert.match(script, /ORKESTR_LOCAL_ENV_FILE/);
  assert.match(script, /ORKESTR_RUNTIME_SETTINGS_FILE/);
  assert.match(script, /local_runtime_path/);
  assert.match(script, /write_env_var PATH/);
  assert.match(script, /install_local_runtime_tools/);
  assert.match(script, /Install missing local runtime tools/);
  assert.match(script, /HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1/);
  assert.match(script, /brew install git tmux ripgrep/);
  assert.match(script, /Use this machine's Codex CLI for coding agents/);
  assert.match(script, /codex login status/);
  assert.match(script, /codex login/);
  assert.match(script, /__orkestr_codex_disabled_on_macos__/);
  assert.match(script, /should_disable_macos_codex_bin/);
  assert.match(script, /should_disable_macos_runtime_codex/);
  assert.match(script, /write_local_env_file/);
  assert.match(script, /write_local_server_wrapper/);
  assert.match(script, /write_local_cli_wrapper/);
  assert.match(script, /install_local_service/);
  assert.match(script, /install_launchd_service/);
  assert.match(script, /install_systemd_user_service/);
  assert.match(script, /install_cron_service/);
  assert.match(script, /local_service_manager/);
  assert.match(script, /launchctl bootstrap/);
  assert.match(script, /systemctl --user enable/);
  assert.match(script, /crontab/);
  assert.match(script, /ORKESTR_LOCAL_SERVICE_MANAGER/);
  assert.match(script, /ORKESTR_LOCAL_SERVER_WRAPPER/);
  assert.match(script, /ORKESTR_LOCAL_CLI_BIN/);
  assert.match(script, /set -a; \. "\$local_env_file"; set \+a; npm start/);
  assert.match(script, /write_runtime_settings_file/);
  assert.match(script, /\$codex_bin --sandbox \$sandbox --ask-for-approval \$approval --no-alt-screen/);
  assert.match(script, /ORKESTR_GMAIL_AUTH_DESKTOP_SLUG/);
  assert.match(script, /ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG/);
  assert.match(script, /"approveReplies": \["\/approve", "approve", "approved", "yes", "y", "allow", "go", "proceed"\]/);
  assert.match(script, /"alwaysApprove"/);
  assert.match(script, /"requiresExplicitScope": true/);
  assert.match(script, /\$\{service_name\}\.service/);
  assert.match(script, /--auto-update/);
  assert.match(script, /--track-main/);
  assert.match(script, /--release-updates\|--versioned-updates/);
  assert.match(script, /--in-place-updates/);
  assert.match(script, /--allow-untagged-releases/);
  assert.match(script, /--require-tagged-releases/);
  assert.match(script, /ORKESTR_GIT_REF/);
  assert.match(script, /ORKESTR_AUTO_UPDATE/);
  assert.match(script, /ORKESTR_UPDATE_REF/);
  assert.match(script, /ORKESTR_RELEASE_DEPLOY/);
  assert.match(script, /ORKESTR_DEPLOY_TAGS_ONLY/);
  assert.match(script, /ORKESTR_DEPLOY_CHANNEL=main/);
  assert.match(script, /ORKESTR_CURRENT_LINK/);
  assert.match(script, /ORKESTR_DEPLOY_ROOT/);
  assert.match(script, /ORKESTR_DEPLOY_CHANNEL/);
  assert.match(script, /ORKESTR_UPDATE_INTERVAL_SECONDS/);
  assert.match(script, /ORKESTR_RESET_ON_UPDATE=\$\{ORKESTR_RESET_ON_UPDATE:-0\}/);
  assert.match(script, /ORKESTR_RESET_OVERLAY=\$\{ORKESTR_RESET_OVERLAY:-0\}/);
  assert.match(script, /sqlite3/);
  assert.match(script, /util-linux/);
  assert.match(script, /useradd --system --home "\$data_dir" --shell \/bin\/bash "\$run_user"/);
  assert.match(script, /usermod --shell \/bin\/bash "\$run_user"/);
  assert.match(script, /install_browser_package/);
  assert.match(script, /install_google_chrome/);
  assert.match(script, /google-chrome-stable/);
  assert.match(script, /dl\.google\.com\/linux\/chrome\/deb/);
  assert.match(script, /browser_command_is_usable/);
  assert.match(script, /timeout 15 "\$cmd" --version/);
  assert.match(script, /checkout_git_ref/);
  assert.match(script, /remote set-url origin "\$repo_url"/);
  assert.match(script, /write_update_units/);
  assert.match(script, /write_deploy_wrapper/);
  assert.match(script, /write_reset_wrapper/);
  assert.match(script, /\$\{service_name\}\.timer/);
  assert.match(script, /ORKESTR_AUTH_REQUIRED=\$\{ORKESTR_AUTH_REQUIRED:-1\}/);
  assert.match(script, /npm ci --include=dev/);
  assert.match(script, /npm install --include=dev/);
  assert.match(script, /Refusing to install Codex automatically on macOS/);
  assert.match(script, /This is not an install error/);
  assert.doesNotMatch(script, /\nprint_macos_codex_notice\n/);
  assert.match(script, /npm install -g "@openai\/codex@\$\{ORKESTR_CODEX_VERSION:-0\.133\.0\}"/);
  assert.match(script, /runuser -u "\$run_user" --preserve-environment -- node/);
  assert.match(script, /ORKESTR_CLI_RUN_AS_ROOT/);
  assert.match(script, /case "\$\{1:-\}" in/);
  assert.match(script, /update\)/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr serve/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr-update/);
  assert.match(script, /systemctl restart "\$\{service_name\}\.service"/);
  assert.doesNotMatch(script, /systemctl enable --now "\$\{service_name\}\.service"/);
  assert.doesNotMatch(script, /--yes/);
  assert.doesNotMatch(script, /ORKESTR_ASSUME_YES/);
  assert.doesNotMatch(script, /orkestr\.install\.env/);
  assert.doesNotMatch(script, /ORKESTR_INSTALL_CONFIG/);
  assert.doesNotMatch(script, /--config-json/);
});

test("uninstall script removes local service wrappers without requiring a clone", async () => {
  const script = await fs.readFile("scripts/uninstall.sh", "utf8");

  await execFileAsync("bash", ["-n", "scripts/uninstall.sh"]);
  assert.match(script, /One-line uninstall/);
  assert.match(script, /raw\.githubusercontent\.com\/otcan\/orkestr\/main\/scripts\/uninstall\.sh/);
  assert.match(script, /launchctl bootout/);
  assert.match(script, /systemctl --user disable --now/);
  assert.match(script, /crontab -l/);
  assert.match(script, /ORKESTR_LOCAL_CLI_BIN/);
  assert.match(script, /ORKESTR_LOCAL_SERVER_WRAPPER/);
  assert.match(script, /safe_remove_path "\$data_dir"/);
  assert.match(script, /--keep-data/);
  assert.match(script, /--keep-source/);
  assert.match(script, /--all/);
  assert.match(script, /ORKESTR_UNINSTALL_REEXECED/);
  assert.match(script, /exec bash "\$uninstall_tmp" "\$@" <\/dev\/tty/);
  assert.match(script, /Remove source checkout outside the managed install path/);
  assert.match(script, /Run with --all to remove source checkouts outside ~\/\.orkestr-src/);
});

test("install script accepts optional JSON config before help", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-install-json-config-"));
  const scriptPath = path.resolve("scripts/install.sh");
  const configPath = path.join(cwd, "orkestr.install.json");
  await fs.writeFile(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 19813,
    installLocalService: false,
    codex: {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    },
  }));

  const { stdout } = await execFileAsync("bash", [scriptPath, "--config", configPath, "--help"], { cwd, timeout: 5000 });

  assert.match(stdout, /--config FILE/);
  assert.match(stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/otcan\/orkestr\/main\/scripts\/install\.sh \| bash/);
});

test("bootstrap script provides an opinionated fresh VPS path", async () => {
  const script = await fs.readFile("scripts/bootstrap-vps.sh", "utf8");

  await execFileAsync("bash", ["-n", "scripts/bootstrap-vps.sh"]);
  assert.match(script, /Ubuntu 24\.04 LTS Server x64/);
  assert.match(script, /https:\/\/github\.com\/otcan\/orkestr\.git/);
  assert.match(script, /--repo URL/);
  assert.match(script, /--ref REF/);
  assert.match(script, /--demo/);
  assert.match(script, /--with-whatsapp/);
  assert.match(script, /--track-main/);
  assert.match(script, /--in-place-updates/);
  assert.match(script, /--release-updates/);
  assert.match(script, /ORKESTR_RELEASE_DEPLOY/);
  assert.match(script, /ORKESTR_DEPLOY_TAGS_ONLY/);
  assert.match(script, /install_args\+=\(--release-updates --update-ref "\$git_ref" --channel "\$deploy_channel"\)/);
  assert.match(script, /--tailscale/);
  assert.match(script, /--no-tailscale/);
  assert.match(script, /--tailscale-up/);
  assert.match(script, /--domain DOMAIN/);
  assert.match(script, /--email EMAIL/);
  assert.match(script, /TS_AUTHKEY/);
  assert.match(script, /ORKESTR_ACME_EMAIL/);
  assert.match(script, /tailscale\.com\/install\.sh/);
  assert.match(script, /tailscale serve --bg 443/);
  assert.match(script, /tailscale serve --bg --https/);
  assert.match(script, /apt_install caddy/);
  assert.match(script, /root \\\* \/usr\/share\/caddy/);
  assert.match(script, /\/etc\/caddy\/conf\.d\/orkestr\.caddy/);
  assert.match(script, /caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(script, /--systemd/);
  assert.match(script, /--auto-update/);
  assert.match(script, /--no-auto-update/);
  assert.match(script, /ORKESTR_RESET_ON_UPDATE=1/);
  assert.match(script, /ORKESTR_RESET_OVERLAY=1/);
  assert.match(script, /WHATSAPP_BRIDGE_MODE local/);
  assert.match(script, /ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED/);
  assert.match(script, /wait_for_orkestr_http/);
  assert.match(script, /\/api\/version/);
  assert.match(script, /Orkestr service did not become ready/);
  assert.match(script, /browser_pairing_required/);
  assert.match(script, /doctor is deferred until browser pairing/);
  assert.match(script, /orkestr doctor/);
  assert.match(script, /systemctl restart orkestr\.service/);
});

test("AWS VPS smoke runner can verify WhatsApp QR readiness", async () => {
  const script = await fs.readFile("scripts/smoke-vps-aws.sh", "utf8");
  const { stdout } = await execFileAsync("bash", ["scripts/smoke-vps-aws.sh", "--help"]);

  await execFileAsync("bash", ["-n", "scripts/smoke-vps-aws.sh"]);
  assert.match(stdout, /--with-whatsapp/);
  assert.match(stdout, /--whatsapp-phone PHONE/);
  assert.match(stdout, /--whatsapp-timeout SEC/);
  assert.match(stdout, /--create-whatsapp-thread NAME/);
  assert.match(script, /bootstrap_args\+=\(--with-whatsapp\)/);
  assert.match(script, /api\/setup\/security\/challenge/);
  assert.match(script, /sudo', \['orkestr', 'security', 'approve'/);
  assert.match(script, /api\/connectors\/whatsapp\/bridge\/accounts\/account-1\/start/);
  assert.match(script, /api\/connectors\/whatsapp\/bridge\/accounts\/account-1\/start-phone/);
  assert.match(script, /api\/connectors\/whatsapp\/status/);
  assert.match(script, /api\/connectors\/whatsapp\/bridge\/qr\.svg\?accountId=account-1/);
  assert.match(script, /tee \/tmp\/orkestr-whatsapp-readiness\.log/);
  assert.match(script, /whatsapp_readiness=qr_needed/);
  assert.match(script, /whatsapp_readiness=paired/);
  assert.match(script, /whatsapp_pairing_code=/);
  assert.match(script, /api\/connectors\/whatsapp\/bridge\/chats/);
});

test("public domain smoke runner validates Caddy/TLS and browser pairing", async () => {
  const script = await fs.readFile("scripts/smoke-public-domain.sh", "utf8");
  const { stdout } = await execFileAsync("bash", ["scripts/smoke-public-domain.sh", "--help"]);

  await execFileAsync("bash", ["-n", "scripts/smoke-public-domain.sh"]);
  assert.match(stdout, /--domain DOMAIN/);
  assert.match(stdout, /--host PUBLIC_IP/);
  assert.match(stdout, /--ssh TARGET/);
  assert.match(stdout, /--keep-session/);
  assert.match(script, /curl --resolve "\$domain:80:\$host_ip"/);
  assert.match(script, /openssl s_client -servername "\$domain"/);
  assert.match(script, /browser_pairing_required/);
  assert.match(script, /api\/setup\/security\/challenge/);
  assert.match(script, /orkestr security approve/);
  assert.match(script, /api\/setup\/security\/pair/);
  assert.match(script, /orkestr security revoke/);
});
