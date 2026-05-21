import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
  assert.match(script, /\/usr\/local\/bin\/orkestr-reset-state/);
  assert.match(script, /ORKESTR_RUN_USER=\$run_user/);
  assert.match(script, /\$\{service_name\}\.service/);
  assert.match(script, /--auto-update/);
  assert.match(script, /ORKESTR_GIT_REF/);
  assert.match(script, /ORKESTR_AUTO_UPDATE/);
  assert.match(script, /ORKESTR_UPDATE_REF/);
  assert.match(script, /ORKESTR_UPDATE_INTERVAL_SECONDS/);
  assert.match(script, /ORKESTR_RESET_ON_UPDATE=\$\{ORKESTR_RESET_ON_UPDATE:-0\}/);
  assert.match(script, /ORKESTR_RESET_OVERLAY=\$\{ORKESTR_RESET_OVERLAY:-0\}/);
  assert.match(script, /sqlite3/);
  assert.match(script, /util-linux/);
  assert.match(script, /install_browser_package/);
  assert.match(script, /install_google_chrome/);
  assert.match(script, /google-chrome-stable/);
  assert.match(script, /dl\.google\.com\/linux\/chrome\/deb/);
  assert.match(script, /browser_command_is_usable/);
  assert.match(script, /timeout 15 "\$cmd" --version/);
  assert.match(script, /checkout_git_ref/);
  assert.match(script, /remote set-url origin "\$repo_url"/);
  assert.match(script, /write_update_units/);
  assert.match(script, /write_reset_wrapper/);
  assert.match(script, /\$\{service_name\}\.timer/);
  assert.match(script, /ORKESTR_AUTH_REQUIRED=\$\{ORKESTR_AUTH_REQUIRED:-1\}/);
  assert.match(script, /npm ci --include=dev/);
  assert.match(script, /npm install --include=dev/);
  assert.match(script, /npm install -g "@openai\/codex@\$\{ORKESTR_CODEX_VERSION:-0\.130\.0\}"/);
  assert.match(script, /runuser -u "\$run_user" --preserve-environment -- node/);
  assert.match(script, /ORKESTR_CLI_RUN_AS_ROOT/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr serve/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr-update/);
  assert.match(script, /systemctl restart "\$\{service_name\}\.service"/);
  assert.doesNotMatch(script, /systemctl enable --now "\$\{service_name\}\.service"/);
  assert.doesNotMatch(script, /docker exec orkestr/);
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
  assert.match(script, /--tailscale/);
  assert.match(script, /--no-tailscale/);
  assert.match(script, /--tailscale-up/);
  assert.match(script, /--domain DOMAIN/);
  assert.match(script, /TS_AUTHKEY/);
  assert.match(script, /tailscale\.com\/install\.sh/);
  assert.match(script, /tailscale serve --bg 443/);
  assert.match(script, /tailscale serve --bg --https/);
  assert.match(script, /apt_install caddy/);
  assert.match(script, /\/etc\/caddy\/conf\.d\/orkestr\.caddy/);
  assert.match(script, /caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(script, /--systemd/);
  assert.match(script, /--auto-update/);
  assert.match(script, /--no-auto-update/);
  assert.match(script, /ORKESTR_RESET_ON_UPDATE=1/);
  assert.match(script, /ORKESTR_RESET_OVERLAY=1/);
  assert.match(script, /WHATSAPP_BRIDGE_MODE local/);
  assert.match(script, /wait_for_orkestr_http/);
  assert.match(script, /\/api\/version/);
  assert.match(script, /Orkestr service did not become ready/);
  assert.match(script, /browser_pairing_required/);
  assert.match(script, /doctor is deferred until browser pairing/);
  assert.match(script, /orkestr doctor/);
  assert.match(script, /systemctl restart orkestr\.service/);
  assert.doesNotMatch(script, /docker exec orkestr/);
});

test("AWS VPS smoke runner can verify WhatsApp QR readiness", async () => {
  const script = await fs.readFile("scripts/smoke-vps-aws.sh", "utf8");
  const { stdout } = await execFileAsync("bash", ["scripts/smoke-vps-aws.sh", "--help"]);

  await execFileAsync("bash", ["-n", "scripts/smoke-vps-aws.sh"]);
  assert.match(stdout, /--with-whatsapp/);
  assert.match(stdout, /--whatsapp-timeout SEC/);
  assert.match(script, /bootstrap_args\+=\(--with-whatsapp\)/);
  assert.match(script, /api\/setup\/security\/challenge/);
  assert.match(script, /sudo', \['orkestr', 'security', 'approve'/);
  assert.match(script, /api\/connectors\/whatsapp\/bridge\/accounts\/account-1\/start/);
  assert.match(script, /api\/connectors\/whatsapp\/status/);
  assert.match(script, /api\/connectors\/whatsapp\/bridge\/qr\.svg\?accountId=account-1/);
  assert.match(script, /whatsapp_readiness=qr_needed/);
  assert.match(script, /whatsapp_readiness=paired/);
});
