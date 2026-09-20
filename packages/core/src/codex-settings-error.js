// Only a correlated JSON-RPC validation rejection proves that no settings
// mutation was accepted. Internal errors and lost replies remain uncertain.
export function classifyCodexSettingsError(error) {
  const rpc = error?.codexRpcMethod === "thread/settings/update";
  const code = rpc && Number.isInteger(error.code) ? error.code : null;
  if (rpc && [-32600, -32601, -32602].includes(code)) {
    const missing = code === -32600 && /^thread (?:not found|not loaded):/i.test(error.message || "");
    return {
      definitive: true, code,
      kind: missing ? "thread_unavailable" : code === -32601 ? "unsupported" : "rejected",
      message: missing
        ? "The runtime has not loaded this thread. Resume the thread, then try the model change again. Your saved model was not changed."
        : code === -32601
          ? "This runtime does not support model changes. Update the Codex runtime and try again. Your saved model was not changed."
          : "The runtime rejected these model settings. Reload the available models and try again. Your saved model was not changed.",
    };
  }
  return { definitive: false, code, kind: String(error?.message || "").startsWith("codex_app_server_timeout:") ? "timeout" : rpc ? "runtime_error" : "transport_error" };
}
