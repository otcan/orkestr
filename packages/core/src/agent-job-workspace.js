// Per-run workspace for native Agent Job attempts. Every run gets its own
// directory under ORKESTR_HOME/agent-job-workspaces/<job>/<run>, so concurrent
// runs of one job never share a checkout. Repository jobs (task.inputs.
// repository_path points at a git repository) get a detached `git worktree`
// of the repository's HEAD there; the repository's own working tree and HEAD
// are not touched. The workspace survives attempts, so a resumed attempt
// continues in the same files. Retention/cleanup is a follow-up.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function safeSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "_";
}

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, env: { PATH: process.env.PATH || "", GIT_TERMINAL_PROMPT: "0", HOME: cwd } });
  return stdout.trim();
}

async function exists(target) {
  return fs.stat(target).then(() => true, () => false);
}

async function repositoryRoot(inputs, baseDir) {
  const target = String(inputs?.repository_path || "").trim();
  if (!target) return null;
  const resolved = path.resolve(baseDir || process.cwd(), target);
  if (!(await exists(resolved))) return null;
  return git(resolved, ["rev-parse", "--show-toplevel"]).catch(() => null);
}

export function agentJobWorkspacePath(home, job, runId) {
  return path.join(home, "agent-job-workspaces", safeSegment(job), safeSegment(runId));
}

/** -> { path, kind: "git_worktree" | "directory", repository: string | null } */
export async function prepareAgentJobWorkspace({ home, baseDir, job, runId, inputs }) {
  const workspace = agentJobWorkspacePath(home, job, runId);
  const repository = await repositoryRoot(inputs, baseDir);
  if (repository) {
    if (!(await exists(path.join(workspace, ".git")))) {
      await fs.mkdir(path.dirname(workspace), { recursive: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await git(repository, ["worktree", "add", "--detach", workspace, "HEAD"]);
    }
    return { path: workspace, kind: "git_worktree", repository };
  }
  await fs.mkdir(workspace, { recursive: true });
  return { path: workspace, kind: "directory", repository: null };
}
