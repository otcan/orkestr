// Synthetic live channel for the headless workspace mock (docs/v2/live-channel.md):
// the event-stream transport only (a WebSocket upgrade gets the mock's 404,
// so the page falls back to the event stream). The test pushes `changed`
// frames and can stall the channel (no hello, no heartbeat).
export function createLive() {
  return { streams: new Set(), opens: [], stalled: false };
}

const frame = (res, value) => res.write(`event: ${value.t}\ndata: ${JSON.stringify(value)}\n\n`);

/** Serves `GET /api/v2/live/events` when `state.liveChannel` is set; true when handled. */
export function liveChannelMock(state) {
  return (req, res, url) => {
    if (!state.liveChannel || url.pathname !== '/api/v2/live/events' || req.method !== 'GET') return false;
    const paths = url.searchParams.getAll('w');
    state.liveChannel.opens.push({ at: Date.now(), paths, resume: url.searchParams.get('resume'),
      fallback_polls: Number(url.searchParams.get('fallback_polls') ?? 0) });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' });
    res.write(`: ${' '.repeat(2048)}\n\n`);
    const stream = { res, paths, send: value => frame(res, value) };
    state.liveChannel.streams.add(stream);
    if (!state.liveChannel.stalled) {
      stream.send({ t: 'hello', v: 1, channel: 'synthetic', transport: 'sse', heartbeat_ms: 400, max_paths: 32 });
      stream.send({ t: 'watching', paths: paths.map(path => ({ path, fp: '~synthetic' })), recent: false });
    }
    const beat = setInterval(() => { if (!state.liveChannel.stalled) stream.send({ t: 'hb', at_ms: Date.now() }); }, 400);
    req.on('close', () => { clearInterval(beat); state.liveChannel.streams.delete(stream); });
    return true;
  };
}

/** Tells every open stream watching `path` that its answer changed. */
export function pushChanged(state, path) {
  let sent = 0;
  for (const stream of state.liveChannel.streams) {
    if (stream.paths.includes(path)) { stream.send({ t: 'changed', paths: [{ path, fp: `~${Date.now()}` }] }); sent += 1; }
  }
  return sent;
}
