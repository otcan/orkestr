import path from "node:path";
import { claudeSubscriptionTokenForRuntime } from "./llm-account-profiles.js";

export function claudeCodeRuntimeEnv(profile = {}, thread = {}, env = process.env) {
  const runtimeHome = path.join(profile.credentialRoot, "runtime-home");
  const runtimeTmp = path.join(profile.credentialRoot, "tmp");
  const permissionMode = String(
    thread?.executor?.metadata?.claudePermissionMode || thread?.claudePermissionMode || "acceptEdits",
  ).trim();
  const source = { ...process.env, ...env };
  const inherited = {};
  for (const key of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
    "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "SSH_AUTH_SOCK",
    "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT", "WINDIR", "PATHEXT",
  ]) {
    if (source[key] !== undefined) inherited[key] = source[key];
  }
  return {
    ...inherited,
    HOME: runtimeHome,
    TMPDIR: runtimeTmp,
    TMP: runtimeTmp,
    TEMP: runtimeTmp,
    CLAUDE_CONFIG_DIR: profile.credentialRoot,
    // Claude's non-write-user hardening forces permission mode back to
    // `default` while this scrub is enabled. An operator who explicitly chose
    // bypassPermissions has already opted into unrestricted tool execution, so
    // preserve that mode instead of silently weakening it at process startup.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: permissionMode === "bypassPermissions" ? "0" : "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

export async function claudeCodeExecutionEnv(profile = {}, thread = {}, env = process.env) {
  const result = claudeCodeRuntimeEnv(profile, thread, env);
  const token = await claudeSubscriptionTokenForRuntime(profile, env);
  if (token) result.CLAUDE_CODE_OAUTH_TOKEN = token;
  return result;
}
