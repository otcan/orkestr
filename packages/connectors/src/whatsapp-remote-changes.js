// Authenticated gateway: adapter export commit -> targeted import -> relay wake.
// The caller advances its cursor only after import AND relay delivery succeed.
import {listThreads} from '../../core/src/threads.js';
import {configuredRemoteThreadBackends, remoteJson, remoteWhatsAppRuntimeBinding,
  syncRemoteWhatsAppThreadMessages} from './whatsapp-remote-runtime.js';

import {noteRemotePushWatch} from './whatsapp-remote-push-state.js';

export async function discoverRemoteMessageWatches(env = process.env, fetchImpl = fetch) {
  const backends = await Promise.all(Object.values(configuredRemoteThreadBackends(env)).map(async backend => {
    try {
      const health = await remoteJson(backend, 'health', fetchImpl);
      return health.messageChanges?.version === 1 && health.messageChanges?.path === 'changes' ? backend.id : null;
    } catch { return null; }
  }));
  return {ok: true, version: 2, backends: backends.filter(Boolean)};
}

/** @param {{backendId?: string, cursor?: string, signal?: AbortSignal, signalOnly?: boolean}} options */
export async function importRemoteMessageChanges({backendId, cursor = '', signal, signalOnly = false} = {}, env = process.env, fetchImpl = fetch) {
  const backend = configuredRemoteThreadBackends(env)[backendId];
  if (!backend) throw Object.assign(new Error('remote_backend_not_configured'), {statusCode: 404});
  if (typeof cursor !== 'string' || cursor.length > 128)
    throw Object.assign(new Error('invalid_change_cursor'), {statusCode: 400});
  // Long-poll expiry is a connection heartbeat, not the import cadence.
  const watchBackend = {...backend, timeoutMs: 35000};
  const change = await remoteJson(watchBackend, `changes?cursor=${encodeURIComponent(cursor)}&waitMs=25000`, fetchImpl,
    {signal});
  if (typeof change.cursor !== 'string' || change.cursor.length > 128 || !Array.isArray(change.threads) ||
      change.threads.some(id => typeof id !== 'string' || id.length > 256))
    throw new Error('remote_change_response_invalid');
  noteRemotePushWatch(backend.id, env);
  const routes = new Set(change.threads);
  const threads = (await listThreads(env)).filter(thread => {
    const remote = remoteWhatsAppRuntimeBinding(thread, env);
    return remote?.backendId === backend.id && remote.binding.remoteMirrorEnabled !== false && routes.has(remote.remoteThreadId);
  });
  if (signalOnly) return {ok: true, cursor: change.cursor, threadIds: threads.map(thread => thread.id), reset: change.reset === true};
  const results = [];
  let retry = false;
  // One slow unrelated binding cannot hold the whole change batch serially.
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, threads.length)}, async () => {
    while (next < threads.length) {
      const thread = threads[next++];
      const result = await syncRemoteWhatsAppThreadMessages(env, fetchImpl, {threadIds: [thread.id], push: true});
      if (result.results.some(row => row.error || row.unmapped)) retry = true;
      results.push(thread.id);
    }
  }));
  return {ok: true, cursor: change.cursor, threadIds: results, retry};
}

/** @param {{backendId: string, threadId: string, signal?: AbortSignal}} options */
export async function importRemoteMessageThread({backendId, threadId, signal}, env = process.env, fetchImpl = fetch) {
  const thread = (await listThreads(env)).find(thread => thread.id === threadId);
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  // A migration/removal after notification is not permission to read the old route.
  if (!remote || remote.backendId !== backendId || remote.binding.remoteMirrorEnabled === false)
    return {ok: true, threadId, skipped: true};
  const result = await syncRemoteWhatsAppThreadMessages(env, fetchImpl, {threadIds: [threadId], push: true, signal});
  return {ok: true, threadId, retry: result.results.some(row => row.error || row.unmapped)};
}
