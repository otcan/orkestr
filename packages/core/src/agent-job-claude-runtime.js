// OS identity the Claude Code job CLI runs as. A root Orkestr server may start
// Claude through a wrapper (ORKESTR_CLAUDE_CODE_BIN) that switches to an
// unprivileged user, because Claude Code refuses some modes as uid 0. That
// user must own the run workspace (it is Claude's cwd, and also the cwd of the
// PreToolUse hook: a hook Claude cannot spawn is a *non-blocking* error, so
// the tool would run unchecked) and must reach the permission broker socket.
// Resolution, only for a root server: ORKESTR_AGENT_JOB_CLAUDE_RUN_USER, else
// the non-root owner of the job Claude config dir (a wrapper hands that
// profile to its run user), else ORKESTR_RUN_USER; null otherwise.
import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  getuid: () => process.getuid?.(),
  passwdFile: "/etc/passwd",
  stat: (target) => fs.stat(target),
  lchown: (target, uid, gid) => fs.lchown(target, uid, gid),
};
let hooks = { ...defaults };

/** Test hook: overrides getuid/passwdFile/stat/lchown; call with no args to reset. */
export function setClaudeJobRuntimeHooksForTest(overrides = null) {
  hooks = { ...defaults, ...(overrides || {}) };
}

function clean(value) {
  return String(value ?? "").trim();
}

async function passwdUser(user) {
  const raw = await fs.readFile(hooks.passwdFile, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 4 || line.startsWith("#") || (parts[0] !== user && parts[2] !== user)) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (Number.isSafeInteger(uid) && Number.isSafeInteger(gid)) return { user: parts[0], uid, gid };
  }
  return null;
}

/** `{ user, uid, gid }` the Claude job CLI runs as when it is not the root server, else null. */
export async function claudeJobRuntimeOwner(env = process.env, { configDir = "" } = {}) {
  if (hooks.getuid() !== 0) return null;
  let owner = null;
  const explicit = clean(env.ORKESTR_AGENT_JOB_CLAUDE_RUN_USER);
  if (explicit) owner = await passwdUser(explicit);
  else if (clean(configDir)) {
    const info = await hooks.stat(configDir).catch(() => null);
    if (info && info.uid !== 0) owner = { user: String(info.uid), uid: info.uid, gid: info.gid };
  }
  if (!owner && !explicit && clean(env.ORKESTR_RUN_USER)) owner = await passwdUser(clean(env.ORKESTR_RUN_USER));
  return owner && owner.uid !== 0 ? owner : null;
}

/** Hands `target` (recursively) to `owner`; no-op without one. */
export async function chownTreeTo(owner, target) {
  if (!owner) return;
  await hooks.lchown(target, owner.uid, owner.gid);
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) await chownTreeTo(owner, child);
    else await hooks.lchown(child, owner.uid, owner.gid);
  }
}
