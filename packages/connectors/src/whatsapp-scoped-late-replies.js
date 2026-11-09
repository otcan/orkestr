// Typed accepted-final identity and bounded completed-route discovery.
export function acceptedRustFinal(message, parent, thread) {
    const binding = thread?.binding || {};
    const backend = binding.remoteBackend || binding.remoteRuntimeBackend || binding.runtimeBackend;
    const remoteThread = binding.remoteThreadId || binding.remoteRuntimeThreadId || binding.delegatedThreadId;
    const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
    return message.source === 'rust-v2-pilot' && message.remoteBackend === 'rust-v2' && backend === 'rust-v2'
      && binding.remoteRuntimeEnabled !== false && binding.remoteRouterEnabled !== false && binding.mirrorToWhatsApp === false
      && parent?.role === 'user' && parent.remoteBackend === backend && parent.remoteThreadId === remoteThread
      && uuid(parent.remoteMessageId) && message.remoteThreadId === remoteThread
      && message.remoteParentMessageId === parent.remoteMessageId && message.remoteOriginalInputId === parent.remoteMessageId
      && message.remoteLayer === 'deep' && message.remoteIdentitySource === 'run'
      && uuid(message.remoteRunId) && uuid(message.remoteMessageId)
      && /^[1-9][0-9]*$/.test(String(message.remoteExportSequence || '')) && Number.isSafeInteger(Number(message.remoteExportSequence));
  }

export function completedLateRoutes({inputs, threadId, readRoute, now, windowMs, fence}) {
  return inputs.flatMap(input => {
    const at = Date.parse(input.created_at), route = readRoute(input.id);
    if (!route || route.thread_id !== threadId || !Number.isFinite(at) || now() - at > windowMs) return [];
    if (fence) {
      const active = fence.read();
      if (active?.route !== fence.routeId || at < Date.parse(active.since)) return [];
    }
    return [{input, at, route}];
  });
}
