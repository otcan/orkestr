import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";

function clean(value) {
  return String(value || "").trim();
}

function isInside(parent, child) {
  const base = path.resolve(clean(parent));
  const candidate = path.resolve(clean(child));
  if (!base || !candidate) return false;
  if (base === candidate) return true;
  const relative = path.relative(base, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function fileExists(filePath) {
  return fs.stat(filePath).then((stats) => stats.isFile()).catch(() => false);
}

function runtimeAgentsMarkdown() {
  return `# AGENTS.md

This is an Orkestr-managed runtime workspace.

Use dynamic discovery for live Orkestr context:

- Run \`orkestr whereiam --json\` from this shell to identify the current
  thread, runtime workspace, repository path, branch, tmux session, and
  available capabilities.
- API callers can use \`GET /api/whereiam?cwd=<absolute-current-directory>\`.
  Pass \`cwd\` explicitly; the API cannot infer a shell's working directory
  from a plain HTTP request.

Orkestr capabilities:

- Threads: \`orkestr list\`, \`orkestr send <thread> "<message>"\`,
  \`orkestr wake <thread>\`, \`orkestr sleep <thread>\`.
- Timers: \`orkestr timers list\`, \`orkestr timers run <timer-id>\`,
  \`orkestr doctor timers\`.
- Browsers/desktops: use \`GET /api/browser-sessions\`,
  \`GET /api/desktops/leases\`, and the desktop acquire/heartbeat/release APIs.
- WhatsApp and Gmail: use connector status APIs and Orkestr routing. Do not
  read connector session files or tokens directly.

Safety rules:

- Do not read files under \`ORKESTR_HOME/secrets\`.
- Do not inspect WhatsApp Web session state, Gmail tokens, or browser profile
  storage directly.
- Do not assume a desktop is free because a profile directory exists; acquire a
  lease first.
`;
}

export async function ensureRuntimeAgentsFile(workspace, env = process.env) {
  const targetWorkspace = clean(workspace);
  if (!targetWorkspace || clean(env.ORKESTR_RUNTIME_AGENTS_MD) === "0") {
    return { written: false, reason: "disabled" };
  }
  const paths = await ensureDataDirs(env);
  const resolvedWorkspace = path.resolve(targetWorkspace);
  const target = path.join(resolvedWorkspace, "AGENTS.md");
  if (await fileExists(target)) return { written: false, reason: "exists", path: target };
  const allowExternal = clean(env.ORKESTR_RUNTIME_AGENTS_MD).toLowerCase() === "force";
  if (!allowExternal && !isInside(paths.workspaces, resolvedWorkspace)) {
    return { written: false, reason: "external_workspace", path: target };
  }
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  await fs.writeFile(target, runtimeAgentsMarkdown(), { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error?.code === "EEXIST") return null;
    throw error;
  });
  return { written: true, path: target };
}
