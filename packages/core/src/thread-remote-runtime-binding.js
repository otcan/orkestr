function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function remoteWhatsAppRuntimeBinding(thread = null, env = process.env) {
  const binding = thread?.binding || {};
  if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") return null;
  if (binding.remoteRuntimeEnabled === false || binding.remoteRouterEnabled === false) return null;
  const remoteThreadId = pickString(binding.remoteThreadId, binding.remoteRuntimeThreadId, binding.delegatedThreadId);
  if (!remoteThreadId) return null;
  const backendId = pickString(
    binding.remoteBackend,
    binding.remoteRuntimeBackend,
    binding.runtimeBackend,
    env.ORKESTR_REMOTE_THREAD_BACKEND_ID,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_ID,
    "default",
  );
  return {
    backendId,
    remoteThreadId,
    binding,
  };
}
