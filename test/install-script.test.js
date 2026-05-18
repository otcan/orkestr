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
  assert.match(script, /\$\{service_name\}\.service/);
  assert.match(script, /--auto-update/);
  assert.match(script, /ORKESTR_GIT_REF/);
  assert.match(script, /ORKESTR_AUTO_UPDATE/);
  assert.match(script, /ORKESTR_UPDATE_REF/);
  assert.match(script, /ORKESTR_UPDATE_INTERVAL_SECONDS/);
  assert.match(script, /sqlite3/);
  assert.match(script, /checkout_git_ref/);
  assert.match(script, /remote set-url origin "\$repo_url"/);
  assert.match(script, /write_update_units/);
  assert.match(script, /\$\{service_name\}\.timer/);
  assert.match(script, /ORKESTR_AUTH_REQUIRED=\$\{ORKESTR_AUTH_REQUIRED:-1\}/);
  assert.match(script, /npm install -g "@openai\/codex@\$\{ORKESTR_CODEX_VERSION:-0\.130\.0\}"/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr serve/);
  assert.match(script, /ExecStart=\/usr\/local\/bin\/orkestr-update/);
  assert.match(script, /systemctl restart "\$\{service_name\}\.service"/);
  assert.doesNotMatch(script, /systemctl enable --now "\$\{service_name\}\.service"/);
  assert.doesNotMatch(script, /docker exec orkestr/);
});
