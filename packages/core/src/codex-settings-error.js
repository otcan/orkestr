// Only a correlated JSON-RPC validation rejection proves that no settings
// mutation was accepted. Internal errors and lost replies remain uncertain.
export function classifyCodexSettingsError(error) {
  const rpc = error?.codexRpcMethod === "thread/settings/update";
  const code = rpc && Number.isInteger(error.code) ? error.code : null;
  if (error?.codexSettingsLoadFailure === true) return {
    definitive: true, code: null, kind: "thread_unavailable",
    message: "Could not load this thread in the runtime. Try again or resume the thread first. Your saved model was not changed.",
  };
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

// A settings RPC addresses an in-memory native thread, not merely its durable
// history. UI reconnects/restarts can leave that history unloaded. Restore the
// SAME thread only after a definitive missing-thread rejection; do not wake the
// Orkestr input queue, reset history, start a turn or override resume settings.
export async function updateLoadedCodexSettings(client, params, { timeoutMs, validate }) {
  const deadline = Date.now() + timeoutMs;
  const request = (method, body) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error(`codex_app_server_timeout:${method}`);
    return client.request(method, body, { timeoutMs: remaining });
  };
  try { return await request("thread/settings/update", params); }
  catch (error) { if (classifyCodexSettingsError(error).kind !== "thread_unavailable") throw error; }
  await validate();
  let resumed;
  try {
    resumed = await request("thread/resume", { threadId: params.threadId });
    if (resumed?.thread?.id !== params.threadId) throw Error("resume_identity_mismatch");
  } catch {
    // The first mutation was rejected and no second mutation has been sent.
    // Even an uncertain resume cannot apply the requested model/effort.
    throw Object.assign(Error("codex_settings_load_failed"), { codexSettingsLoadFailure: true });
  }
  await validate();
  return request("thread/settings/update", params);
}
