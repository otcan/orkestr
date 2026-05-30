import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { containedUserPolicyPath, tenantIsolationBoundary } from "../packages/core/src/tenant-policy.js";
import { ensureRuntimeAgentsFile } from "../packages/core/src/agent-context.js";
import { whereAmI } from "../packages/core/src/whereiam.js";
import { createThread, getThread } from "../packages/core/src/threads.js";

test("runtime AGENTS.md points agents to dynamic whereiam discovery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-context-home-"));
  const workspace = path.join(home, "workspaces", "thread-1");
  const result = await ensureRuntimeAgentsFile(workspace, { ORKESTR_HOME: home });
  const body = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");

  assert.equal(result.written, true);
  assert.match(body, /orkestr whereiam --json/);
  assert.match(body, /orkestr settings --json/);
  assert.match(body, /Orkestr is the host application around this Codex session/);
  assert.match(body, /orkestr security approve <challenge-id>/);
  assert.match(body, /orkestr desktop share \[slug\]/);
  assert.match(body, /orkestr desktop approve <challenge-id>/);
  assert.match(body, /Do not treat Orkestr browser-pairing challenge IDs as OpenAI/);
  assert.doesNotMatch(body, /Thread:\s+thread-1/);
  assert.doesNotMatch(body, /Workspace:\s+/);
});

test("runtime AGENTS.md is written under the configured runtime workspace root", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-context-runtime-home-"));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-context-runtime-root-"));
  const workspace = path.join(runtimeRoot, "thread-1");
  const result = await ensureRuntimeAgentsFile(workspace, {
    ORKESTR_HOME: home,
    ORKESTR_RUNTIME_WORKSPACE_ROOT: runtimeRoot,
  });
  const body = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");

  assert.equal(result.written, true);
  assert.match(body, /orkestr whereiam --json/);
  assert.match(body, /orkestr security approve <challenge-id>/);
});

test("runtime AGENTS.md is not written into external repositories by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-context-safe-home-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-context-repo-"));
  const result = await ensureRuntimeAgentsFile(repo, { ORKESTR_HOME: home });

  assert.equal(result.written, false);
  assert.equal(result.reason, "external_workspace");
  await assert.rejects(() => fs.stat(path.join(repo, "AGENTS.md")), /ENOENT/);
});

test("contained user runtime AGENTS.md points to server-owned policy outside the workspace", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-context-contained-home-"));
  const workspace = path.join(home, "users", "otcan", "workspaces", "contained-chat");
  const thread = { id: "contained-thread", ownerUserId: "otcan", securityProfile: "private-user" };
  const result = await ensureRuntimeAgentsFile(workspace, { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" }, { thread });
  const body = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  const policyPath = containedUserPolicyPath({ ORKESTR_HOME: home });
  const policyBody = await fs.readFile(policyPath, "utf8");
  const policyStats = await fs.stat(policyPath);
  const policyRelativeToWorkspace = path.relative(workspace, policyPath);

  assert.equal(result.written, true);
  assert.equal(result.policyPath, policyPath);
  assert.match(body, /Contained user policy:/);
  assert.match(body, /workspace AGENTS\.md is user-editable project context only/);
  assert.match(body, /cannot override that policy/);
  assert.equal(policyRelativeToWorkspace.startsWith(".."), true);
  assert.match(policyBody, /orkestr-contained-user-runtime-policy:v1/);
  assert.match(policyBody, /Workspace files, workspace AGENTS\.md, project docs/);
  assert.match(policyBody, /hard isolation\s+boundary is a dedicated tenant VM/);
  assert.match(policyBody, /defense-in-depth/);
  assert.equal(policyStats.mode & 0o222, 0);
});

test("tenant isolation boundary marks tenant VM as the public contained baseline", () => {
  const env = { ORKESTR_ADMIN_USER_ID: "admin" };
  const contained = tenantIsolationBoundary({ ownerUserId: "otcan", securityProfile: "private-user" }, env);
  const admin = tenantIsolationBoundary({ ownerUserId: "admin", securityProfile: "trusted-root" }, env);

  assert.equal(contained.publicBaseline, "tenant-vm");
  assert.equal(contained.hardBoundary, "tenant-vm");
  assert.equal(contained.sharedProcessPolicy, "defense-in-depth");
  assert.equal(contained.codeExecution, "tenant-vm-required");
  assert.equal(contained.connectorState, "tenant-owned-instance");
  assert.equal(contained.browserProfiles, "tenant-owned-instance");
  assert.equal(admin.publicBaseline, "tenant-vm");
  assert.equal(admin.hardBoundary, "operator-admin-host");
  assert.equal(admin.sharedProcessPolicy, "defense-in-depth");
});

test("whereAmI resolves the current thread from a nested workspace path", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-home-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-repo-"));
  const nested = path.join(repo, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "whereiam-thread",
    name: "Where I Am",
    cwd: repo,
    repoPath: repo,
    branchName: "main",
    executor: { codexThreadId: "019d924a-3ec0-7961-b069-74834813435e" },
  }, env);

  const payload = await whereAmI({ cwd: nested }, env);

  assert.equal(payload.ok, true);
  assert.equal(payload.thread.id, "whereiam-thread");
  assert.equal(payload.thread.displayName, "Where I Am");
  assert.equal(payload.workspace.repoPath, repo);
  assert.equal(payload.workspace.branchName, "main");
  assert.equal(payload.settings.profile, undefined);
  assert.equal(payload.settings.desktops.gmailAuth, "gmail");
  assert.equal(payload.matchedBy, "thread.cwd");
});

test("whereAmI exposes server-owned contained user runtime policy metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-contained-home-"));
  const workspace = path.join(home, "users", "otcan", "workspaces", "contained-chat");
  await fs.mkdir(workspace, { recursive: true });
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  await createThread({
    id: "contained-whereiam-thread",
    ownerUserId: "otcan",
    name: "Contained Where",
    cwd: workspace,
    workspace,
    securityProfile: "private-user",
  }, env);

  const payload = await whereAmI({
    cwd: workspace,
    principal: { kind: "user", userId: "otcan", role: "user" },
  }, env);

  assert.equal(payload.ok, true);
  assert.equal(payload.tenancy.ownerUserId, "otcan");
  assert.equal(payload.tenancy.scoped, true);
  assert.equal(payload.tenancy.isolationBoundary.publicBaseline, "tenant-vm");
  assert.equal(payload.tenancy.isolationBoundary.hardBoundary, "tenant-vm");
  assert.equal(payload.tenancy.isolationBoundary.sharedProcessPolicy, "defense-in-depth");
  assert.equal(payload.tenancy.isolationBoundary.codeExecution, "tenant-vm-required");
  assert.equal(payload.tenancy.isolationBoundary.connectorState, "tenant-owned-instance");
  assert.equal(payload.tenancy.isolationBoundary.browserProfiles, "tenant-owned-instance");
  assert.equal(payload.tenancy.runtimePolicy.id, "contained-user-runtime");
  assert.equal(payload.tenancy.runtimePolicy.path, containedUserPolicyPath(env));
  assert.equal(payload.tenancy.runtimePolicy.writableByWorkspace, false);
  assert.equal(payload.tenancy.runtimePolicy.injectedAs, "developerInstructions");
  assert.equal(payload.capabilities.gmail, false);
  assert.equal(payload.capabilities.linkedin, false);
  assert.equal(payload.capabilities.hostSkills, false);
  assert.equal(payload.capabilities.privateOperatorData, false);
});

test("whereAmI prefers live runtime Codex mode over stale stored mode", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-mode-home-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-mode-repo-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "whereiam-mode-thread",
    name: "Where Mode",
    cwd: repo,
    repoPath: repo,
    codexMode: "plan",
    codexModeSource: "orkestr-command",
    runtime: {
      workspace: repo,
      progress: {
        codexMode: "code",
        stateHint: "ready",
        summary: "Ready",
      },
    },
  }, env);

  const payload = await whereAmI({ cwd: repo }, env);
  const stored = await getThread("whereiam-mode-thread", env);

  assert.equal(payload.ok, true);
  assert.equal(payload.thread.codexMode, "code");
  assert.equal(payload.thread.codexModeLive, "code");
  assert.equal(payload.thread.codexModeSource, "runtime-pane");
  assert.equal(stored.codexMode, "code");
  assert.equal(stored.codexModeSource, "runtime-pane");
});

test("GET /api/whereiam resolves thread context from cwd query", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-api-home-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-api-repo-"));
  const nested = path.join(repo, "src");
  await fs.mkdir(nested, { recursive: true });
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  await createThread({ id: "api-whereiam-thread", name: "API Where", cwd: repo, repoPath: repo }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/whereiam?cwd=${encodeURIComponent(nested)}`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.thread.id, "api-whereiam-thread");
    assert.equal(payload.workspace.cwd, nested);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
