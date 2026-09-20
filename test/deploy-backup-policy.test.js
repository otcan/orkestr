import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isolatedSmokeBaseEnvironment } from "../scripts/smoke-environment.mjs";

const exec = promisify(execFile);
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-backup-policy-"));
  const home = path.join(root, "state");
  await fs.mkdir(home); await fs.writeFile(path.join(home,"fixture.txt"),"preserved user data");
  const env = {...isolatedSmokeBaseEnvironment(), ORKESTR_ENV_FILE:path.join(root,"missing.env"),ORKESTR_HOME:home,
    ORKESTR_DEPLOY_ROOT:path.join(root,"deploy"),ORKESTR_DEPLOY_LOCK_FILE:path.join(root,"deploy.lock"),
    ORKESTR_DEPLOY_BACKUP_COMPRESSOR:"gzip",ORKESTR_DEPLOY_BACKUP_KEEP:"1"};
  try { await run({root,home,env,backups:path.join(root,"deploy","backups")}); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
}
async function status(env,args=[]) {
  return JSON.parse((await exec("bash",["scripts/deploy-git-release.sh","status","--json",...args],{env})).stdout);
}
test("scheduled code-only policy is persistent while unconfigured hosts remain conservative",async()=>{
  await fixture(async({env})=>{
    assert.equal((await status(env)).perReleaseBackup,1);
    const scheduled={...env,ORKESTR_DEPLOY_BACKUP_POLICY:"scheduled"};
    assert.equal((await status(scheduled)).perReleaseBackup,0);
    assert.equal((await status(scheduled,["--backup"])).perReleaseBackup,1);
    assert.equal((await status({...scheduled,ORKESTR_DEPLOY_BACKUP_STATE:"0"},["--state-change"])).perReleaseBackup,1);
    await assert.rejects(status(scheduled,["--state-change","--no-backup"]),/Cannot disable/);
    await assert.rejects(status({...scheduled,ORKESTR_DEPLOY_STATE_CHANGE:"1"},["--no-backup"]),/Cannot disable/);
    await assert.rejects(status({...env,ORKESTR_DEPLOY_BACKUP_POLICY:"typo"}),/Invalid backup policy/);
  });
});
test("nightly command creates a restorable private archive without a build/restart or env override",async()=>{
  await fixture(async({root,env,backups})=>{
    const {stdout}=await exec("bash",["scripts/deploy-git-release.sh","backup"],{env:{...env,ORKESTR_DEPLOY_BACKUP_POLICY:"scheduled",ORKESTR_DEPLOY_BACKUP_STATE:"0"}});
    const archive=stdout.trim(); assert.equal(path.dirname(archive),backups);
    assert.equal((await fs.stat(archive)).mode & 0o777,0o600);
    const restored=path.join(root,"restored");await fs.mkdir(restored);
    await exec("tar",["-xf",archive,"-C",restored]);
    assert.equal(await fs.readFile(path.join(restored,"state","fixture.txt"),"utf8"),"preserved user data");
    assert.deepEqual((await fs.readdir(backups)).filter(n=>n.endsWith('.part')),[]);
  });
});
test("scheduled freshness gate rejects absent, stale, empty and in-progress archives",async()=>{
  await fixture(async({env,backups})=>{
    const command='set -euo pipefail; source scripts/deploy-backup-policy.sh; backup_policy=scheduled; backup_max_age=129600; backup_dir="$TEST_BACKUPS"; require_recent_state_backup';
    const run=()=>exec("bash",["-c",command],{env:{...env,TEST_BACKUPS:backups}});
    await assert.rejects(run(),/missing\/stale/);
    await fs.mkdir(backups,{recursive:true});
    await fs.writeFile(path.join(backups,".state-backup.pending.part"),"pending");
    await fs.writeFile(path.join(backups,"empty-state.tar.gz"),"");
    await assert.rejects(run(),/missing\/stale/);
    const completed=path.join(backups,"complete-state.tar.gz");await fs.writeFile(completed,"completed fixture");
    await run();
    await fs.utimes(completed,1,1); await assert.rejects(run(),/missing\/stale/);
  });
});
test("failed replacement preserves the last completed archive even with keep=1",async()=>{
  await fixture(async({root,env,backups})=>{
    const {stdout}=await exec("bash",["scripts/deploy-git-release.sh","backup"],{env});
    const archive=stdout.trim(), prior=await fs.readFile(archive);
    const bin=path.join(root,"bin");await fs.mkdir(bin);
    await fs.writeFile(path.join(bin,"gzip"),"#!/bin/sh\nexit 7\n",{mode:0o755});
    await assert.rejects(exec("bash",["scripts/deploy-git-release.sh","backup"],{env:{...env,PATH:bin+path.delimiter+env.PATH}}));
    assert.deepEqual(await fs.readFile(archive),prior);
    assert.deepEqual(await fs.readdir(backups),[path.basename(archive)]);
  });
});
test("required backup rejects a missing source and cannot be disabled",async()=>{
  await fixture(async({root,env})=>{
    await assert.rejects(exec("bash",["scripts/deploy-git-release.sh","backup"],{env:{...env,ORKESTR_HOME:path.join(root,"absent")}}),/source is missing/);
    await assert.rejects(exec("bash",["scripts/deploy-git-release.sh","backup","--no-backup"],{env}),/Cannot disable/);
  });
});
test("backup lock contention is visible to schedulers and produces no archive",async()=>{
  await fixture(async({env,backups})=>{
    await assert.rejects(exec("flock",[env.ORKESTR_DEPLOY_LOCK_FILE,"bash","scripts/deploy-git-release.sh","backup"],{env:{...env,ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE:"75"}}),error=>error.code===75);
    await assert.rejects(fs.stat(backups),error=>error.code==='ENOENT');
  });
});
test("a compressor producing invalid bytes cannot publish a completed archive",async()=>{
  await fixture(async({root,env,backups})=>{
    const bin=path.join(root,"bin");await fs.mkdir(bin);
    await fs.writeFile(path.join(bin,"gzip"),"#!/bin/sh\ncat >/dev/null\nprintf invalid-archive\n",{mode:0o755});
    await assert.rejects(exec("bash",["scripts/deploy-git-release.sh","backup"],{env:{...env,PATH:bin+path.delimiter+env.PATH}}),/verification failed/);
    assert.deepEqual(await fs.readdir(backups),[]);
  });
});
