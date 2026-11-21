// How `orkestr attach` opens a V2 chat's native provider session in this
// terminal, as close to a V2 run as a terminal can be.
//
// V2 runs its providers inside the V2 service's mount namespace, where the
// provider profile is an idmapped mount (the profile owner's files appear as
// the executor's), as the executor user under no_new_privs. The terminal
// session enters that same mount namespace and identity, so it reads and
// appends the very transcript V2 resumes, and every file it writes keeps the
// ownership V2 expects. What it lacks: the per-run orkestr_managed MCP tools
// (issued by the V2 manager for a run) and the run's cgroup.
//
// The interactive command is the provider's own TUI resume:
//   claude:  <executable> --resume <session> --dangerously-skip-permissions
//   codex:   <release>/package/native --dangerously-bypass-approvals-and-sandbox resume <thread>
import fs from "node:fs";

function clean(value) {
  return String(value ?? "").trim();
}

function launchError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// KEY=VALUE lines (comments and blanks skipped). Values are never printed.
export function parseEnvironmentFile(text) {
  const values = {};
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const passthrough = ["TERM", "COLORTERM", "TERM_PROGRAM", "LC_TERMINAL", "COLUMNS", "LINES"];

// The launch for one native session. `plan` is the deployment's selected
// plan, `settings` the conversation's V2 settings (model, effort).
export function buildNativeLaunch({ plan, native, conversationId, settings = {}, namespacePid, env = process.env, readFile = fs.readFileSync }) {
  if (!plan || !native?.nativeSessionId) throw launchError("v2_native_launch_unavailable", "no selected plan or native session");
  if (!Number.isInteger(namespacePid) || namespacePid <= 1) throw launchError("v2_native_launch_unavailable", "V2 service is not running (no mount namespace to enter)");
  const uid = Number(plan.executor_uid ?? plan.uid);
  const gid = Number(plan.executor_gid ?? plan.gid);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) throw launchError("v2_native_launch_unavailable", "plan names no executor identity");
  const terminal = Object.fromEntries(passthrough.filter((key) => env[key]).map((key) => [key, env[key]]));
  let cwd;
  let environment;
  let argv;
  if (native.provider === "claude") {
    const c = plan.claude || {};
    if (!c.executable || !c.account || !c.workspace) throw launchError("v2_native_launch_unavailable", "plan names no Claude launch");
    cwd = c.workspace;
    environment = {
      ...(c.managed_host?.environment || { HOME: c.home, TMPDIR: c.temporary, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }),
      CLAUDE_CONFIG_DIR: c.account,
      // Same as V2 runs: a detached background task would outlive the session.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      ...(clean(settings.model) ? { ANTHROPIC_MODEL: clean(settings.model) } : {}),
      ...(["low", "medium", "high", "max"].includes(clean(settings.reasoning_effort)) ? { CLAUDE_CODE_EFFORT_LEVEL: clean(settings.reasoning_effort) } : {}),
    };
    argv = [c.executable, "--resume", native.nativeSessionId, "--dangerously-skip-permissions"];
  } else if (native.provider === "codex") {
    const host = plan.managed_host || {};
    if (!plan.native || !host.environment?.CODEX_HOME) throw launchError("v2_native_launch_unavailable", "plan names no Codex launch");
    cwd = plan.conversation_workspaces?.[conversationId]?.path || plan.workspace;
    const files = Array.isArray(host.environment_files) ? host.environment_files : [];
    environment = {};
    for (const file of files) Object.assign(environment, parseEnvironmentFile(readFile(file, "utf8")));
    Object.assign(environment, host.environment);
    // The release package's copy is the one the executor may run (the
    // native-assets original is root/orkestr only); both are the same binary.
    const binary = plan.output ? `${String(plan.output).replace(/\/+$/, "")}/package/native` : plan.native;
    argv = [binary, "--dangerously-bypass-approvals-and-sandbox", "resume", native.nativeSessionId];
  } else {
    throw launchError("v2_native_launch_unavailable", `unknown provider ${native.provider}`);
  }
  if (!cwd) throw launchError("v2_native_launch_unavailable", "plan names no workspace");
  const envArgs = Object.entries({ ...environment, ...terminal }).map(([key, value]) => `${key}=${value}`);
  return {
    // Enter V2's mount namespace, become the executor (no_new_privs), clean env.
    command: "nsenter",
    args: ["--target", String(namespacePid), "--mount", `--wd=${cwd}`, "--",
      "setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--init-groups", "--no-new-privs", "--",
      "env", "-i", ...envArgs, ...argv],
    describe: {
      provider: native.provider,
      session: native.nativeSessionId,
      uid,
      gid,
      cwd,
      argv,
      envKeys: Object.keys({ ...environment, ...terminal }).sort(),
    },
  };
}
