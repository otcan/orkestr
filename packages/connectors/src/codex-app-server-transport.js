export function cleanAppServerValue(value) {
  return String(value || "").trim();
}

export function codexAppServerMode(env = process.env) {
  const mode = cleanAppServerValue(env.ORKESTR_CODEX_APP_SERVER_MODE).toLowerCase();
  return mode || "stdio";
}

export function codexAppServerSocket(env = process.env) {
  return cleanAppServerValue(env.ORKESTR_CODEX_APP_SERVER_SOCKET);
}

export function codexAppServerUsesProxy(env = process.env) {
  const mode = codexAppServerMode(env);
  return mode === "external" || mode === "proxy" || mode === "daemon" || Boolean(codexAppServerSocket(env));
}

export function codexAppServerClientArgs(env = process.env) {
  if (!codexAppServerUsesProxy(env)) return ["app-server", "--listen", "stdio://"];
  const socket = codexAppServerSocket(env);
  return ["app-server", "proxy", ...(socket ? ["--sock", socket] : [])];
}

export function codexAppServerTransport(env = process.env) {
  return codexAppServerUsesProxy(env) ? "proxy" : "stdio";
}
