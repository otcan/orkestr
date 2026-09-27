import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createThread } from "../packages/core/src/threads.js";
import { createThreadWorker } from "../packages/core/src/thread-workers.js";

const execFileAsync = promisify(execFile);

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function adminCookie(baseUrl) {
  const challenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
  await approvePairingChallenge(challenge.challengeId, { env: process.env });
  const pair = await fetch(`${baseUrl}/api/setup/security/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId }),
  });
  assert.equal(pair.status, 200);
  return pair.headers.get("set-cookie") || "";
}

async function createTempGitRepo(prefix) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "orkestr@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Orkestr Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "# test repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

test("thread standing mission API is admin-only, validates, and round-trips", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mission-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  t.after(async () => {
    if (priorHome === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED; else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const cookie = await adminCookie(baseUrl);
  await createThread({ id: "mission-api-thread", name: "Mission API Thread" }, process.env);

  const deniedGet = await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`);
  assert.equal(deniedGet.status, 401);
  const deniedPut = await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mission: "do the thing" }),
  });
  assert.equal(deniedPut.status, 401);

  const emptyGetResponse = await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`, { headers: { cookie } });
  const emptyGet = await read(emptyGetResponse);
  assert.equal(emptyGetResponse.status, 200, JSON.stringify(emptyGet));
  assert.equal(emptyGet.standingMission, null);

  const invalidSet = await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  assert.equal(invalidSet.status, 400);

  const set = await read(await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ mission: "Keep the backlog green." }),
  }));
  assert.equal(set.standingMission, "Keep the backlog green.");
  assert.ok(set.standingMissionUpdatedAt);

  const fetched = await read(await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`, { headers: { cookie } }));
  assert.equal(fetched.standingMission, "Keep the backlog green.");

  const cleared = await read(await fetch(`${baseUrl}/api/threads/mission-api-thread/mission`, {
    method: "DELETE",
    headers: { cookie },
  }));
  assert.equal(cleared.standingMission, null);
});

test("worker push-branch API is admin-only and pushes only the worker's own branch", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-push-branch-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  const repo = await createTempGitRepo("orkestr-push-branch-api-repo-");
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-push-branch-api-remote-"));
  const remote = path.join(remoteDir, "origin.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repo });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repo });
  t.after(async () => {
    if (priorHome === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED; else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = await adminCookie(baseUrl);

  const parent = await createThread({ id: "push-branch-parent", name: "Push Branch Parent", cwd: repo }, process.env);
  const created = await createThreadWorker(parent.id, { label: "Push Branch Worker", autoRun: false, wake: false }, process.env);
  const worker = created.worker;

  const deniedPush = await fetch(`${baseUrl}/api/threads/${worker.id}/push-branch`, { method: "POST" });
  assert.equal(deniedPush.status, 401);

  await fs.writeFile(path.join(worker.worktreePath, "api-change.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "api-change.txt"], { cwd: worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "api change"], { cwd: worker.worktreePath });

  const arbitraryRefspec = await fetch(`${baseUrl}/api/threads/${worker.id}/push-branch`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ branch: "main" }),
  });
  assert.equal(arbitraryRefspec.status, 400);

  const pushedResponse = await fetch(`${baseUrl}/api/threads/${worker.id}/push-branch`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
  const pushed = await read(pushedResponse);
  assert.equal(pushedResponse.status, 200, JSON.stringify(pushed));
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.remoteBranch, `origin/${worker.branchName}`);
  assert.equal(pushed.thread.remoteBranch, `origin/${worker.branchName}`);
});
