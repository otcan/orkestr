import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const script=await fs.readFile(path.join(root,'scripts/deploy-git-release.sh'),'utf8');
const helper=await fs.readFile(path.join(root,'scripts/deploy-ui-scope.sh'),'utf8');
function fn(name) {
  const start=script.indexOf(`${name}() {\n`);assert.ok(start>=0,name);
  const end=script.indexOf('\n}\n',start);assert.ok(end>start,name);
  return script.slice(start,end+3);
}
function shell(source,args=[]) {return execFileSync('/bin/bash',['--noprofile','--norc','-c',source,'test',...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C'}});}
const setup=`set -eu\n${helper}\nui_only_arg=1\ncommand=install\ncurrent_link="$1"\nORKESTR_APP_DIR="$1"\nORKESTR_CURRENT_LINK="$1"\nORKESTR_RELEASE_DEPLOY=1\ncodex_app_server_mode=external\nservice_name=ui\ncodex_app_server_service_name=codex\nsync_public_service=1\nsync_mailbox_mta=1\nsync_workers=1\nfanout_arg=1\nORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS=explicit-account\nORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND=forbidden-command\nsystemctl() { case "$*" in 'is-active --quiet ui.service'|'is-active --quiet codex.service') return 0;; 'show -p WorkingDirectory --value ui.service') printf '%s\\n' "$current_link";; *) echo unexpected-systemctl >&2;return 99;; esac; }\n`;
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'orkestr-ui-scope-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'release'));await fs.symlink('release',path.join(dir,'current'));
  return path.join(dir,'current');
}

test('UI-only helper narrows side effects while preserving explicitly requested WA check',async t=>{
  const link=await fixture(t);
  const result=shell(setup+`apply_ui_only_scope\n[ "$sync_public_service:$sync_mailbox_mta:$sync_workers:$fanout_arg" = '0:0:0:0' ]\n[ "$ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS" = explicit-account ]\n[ -z "$ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND" ]\necho verified`,[link]);
  assert.match(result,/verified/);
});

test('UI-only fails before activation for wrong install layout or in-process runtime',async t=>{
  const link=await fixture(t);
  for(const change of ['ORKESTR_APP_DIR=/different','ORKESTR_RELEASE_DEPLOY=0','codex_app_server_mode=stdio','command=backup']) {
    assert.throws(()=>shell(setup+`${change}\napply_ui_only_scope`,[link]));
  }
});

test('UI-only rollback remains available with UI stopped and external Codex active',async t=>{
  const link=await fixture(t);
  const source=setup+`command=rollback\nsystemctl() { case "$*" in 'is-active --quiet ui.service') return 3;; 'is-active --quiet codex.service') return 0;; 'show -p WorkingDirectory --value ui.service') printf '%s\\n' "$current_link";; *) return 99;; esac; }\napply_ui_only_scope\necho verified`;
  assert.match(shell(source,[link]),/verified/);
});

test('guarded mutation paths return before any filesystem/process/service command',()=>{
  const names=['sync_versioned_env','send_release_whatsapp_notifications','repair_env_file_permissions','ensure_codex_app_server_split_for_target','refresh_parent_whatsapp_bridge_proxy','sync_standalone_connectors_release','configure_service_shutdown_timeout','repair_runtime_ownership'];
  const mocks=['systemctl','chown','chmod','mkdir','touch','node','npm','git','id','find','sed','env_file_value','set_env_assignment','random_private_token'].map(n=>`${n}() { echo forbidden-${n} >&2; return 99; }`).join('\n');
  const source=`set -eu\n${helper}\nui_only_arg=1\n${mocks}\n${names.map(fn).join('\n')}\n${names.map(n=>`${n} /fake/release`).join('\n')}\necho guarded`;
  assert.equal(shell(source).trim(),'guarded');
});

test('restart retains UI restart/health/exposure and drain gates with unrelated services disabled',()=>{
  const names=['sync_standalone_connectors_release','refresh_parent_whatsapp_bridge_proxy','configure_service_shutdown_timeout','restart_and_verify'];
  const source=`set -eu\n${helper}\nui_only_arg=1\nservice_name=ui\nhealth_url=http://fake.invalid\ndeploy_drain_started=1\n${names.map(fn).join('\n')}\nsystemctl() { case "$*" in 'restart ui.service') echo ui-restart;; 'is-active --quiet ui.service') echo ui-active;; *) echo forbidden >&2;return 99;; esac; }\nhealth_check() { echo health; }\nrestart_and_verify_public_service() { :; }\nrestart_and_verify_mailbox_mta() { :; }\ndeploy_public_exposure_check() { echo exposure; }\nclear_deploy_drain() { echo drain-cleared; }\nrestart_and_verify`;
  const output=shell(source);for(const gate of ['ui-restart','ui-active','health','exposure','drain-cleared'])assert.match(output,new RegExp(gate));
});

test('normal helper mode is a no-op and does not inspect services',()=>{
  assert.equal(shell(`set -eu\n${helper}\nui_only_arg=0\nsystemctl() { exit 99; }\napply_ui_only_scope\necho normal`).trim(),'normal');
});

test('canonical install executes both provenance gates, drain, backup and health in order',()=>{
  const build=(failure='')=>`set -eu
exec 2>&1
${helper}
ui_only_arg=1
releases_dir=/fake/never-created/releases
repo_cache=/fake/repo
repo_url=https://example.invalid/repo.git
deploy_ref=approved
deploy_channel=production
tags_only_arg=1
sync_workers=0
fanout_arg=0
${['repair_runtime_ownership','ensure_codex_app_server_split_for_target','sync_versioned_env','send_release_whatsapp_notifications','install_command'].map(fn).join('\n')}
mkdir() { :; }
prune_release_directories() { :; }
prepare_repo_cache() { :; }
resolve_target_ref() { echo 0123456789abcdef; }
git() { echo reviewed-tag; }
sanitize_id() { printf '%s' "$1"; }
current_release_id() { echo old-release; }
date() { echo mock-time; }
release_is_complete() { return 0; }
mktemp() { echo /fake/provenance; }
provenance_gate() { echo gate-$1; [ "$1" != "${failure}" ] || return 77; }
deploy_guard_before_restart() { echo drain; }
backup_state() { echo backup >&2; echo /fake/backup; }
activate_release() { echo activate; }
restart_and_verify() { echo health; }
verify_required_whatsapp_accounts() { echo explicit-wa-check; }
release_train_instance_fanout() { :; }
sync_safe_workers_after_deploy() { :; }
write_history_event() { echo history; }
npm() { echo forbidden-build >&2; return 99; }
node() { echo forbidden-node >&2; return 99; }
install_command`;
  const output=shell(build());
  const expected=['gate-pre','gate-post','drain','backup','activate','health','explicit-wa-check','history'];
  let cursor=-1;for(const step of expected){const next=output.indexOf(step,cursor+1);assert.ok(next>cursor,step);cursor=next;}
  for(const phase of ['pre','post']){
    let error;try{shell(build(phase));}catch(e){error=e;}
    assert.equal(error?.status,77);assert.doesNotMatch(String(error?.stdout),/\nactivate\n|\nbackup\n/);
  }
});
