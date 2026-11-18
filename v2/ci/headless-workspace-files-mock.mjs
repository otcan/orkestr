// The Files panel's chat folder routes, synthetic entries only. Chat A works
// in the shared default folder; every other chat in its own folder.
const MODIFIED = Date.parse('2026-11-18T10:00:00Z');
// A 1x1 transparent PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const FILES = {
  'report.md': '# Synthetic report\n\nAll checks green.\n',
  'docs/plan.md': '# Synthetic plan\n\n1. Read\n2. Write\n',
};
const FOLDERS = {
  '': [
    {name: 'docs', kind: 'dir', modified_ms: MODIFIED - 60000},
    {name: 'chart.png', kind: 'file', size: PIXEL.length, modified_ms: MODIFIED},
    {name: 'report.md', kind: 'file', size: Buffer.byteLength(FILES['report.md']), modified_ms: MODIFIED - 120000},
    {name: 'escape', kind: 'link', target: 'outside', modified_ms: MODIFIED - 180000},
  ],
  docs: [{name: 'plan.md', kind: 'file', size: Buffer.byteLength(FILES['docs/plan.md']), modified_ms: MODIFIED - 30000}],
};

export async function workspaceFilesApi(state, req, res, id, rest, q, {json, A}) {
  if (req.method !== 'GET' || !rest.startsWith('/workspace')) return false;
  const path = q.get('path') ?? '';
  state.workspaceReads = [...(state.workspaceReads ?? []), `${rest} ${path}`];
  if (path.split('/').some(part => part === '..' || part.startsWith('.'))) {
    json(res, 403, {code: 'workspace_protected', message: 'This file is protected and is never shown'});
    return true;
  }
  if (rest === '/workspace') {
    const entries = FOLDERS[path];
    if (!entries) {
      json(res, 404, {code: 'workspace_not_found', message: 'No such file or folder'});
      return true;
    }
    const shared = id === A;
    json(res, 200, {conversation_id: id, state: 'ready', root_kind: shared ? 'shared_default' : 'conversation',
      root_name: shared ? 'workspace' : 'research-notes', path, entries, hidden: path === '' ? 2 : 0, truncated: false});
    return true;
  }
  const name = path.split('/').pop();
  if (rest === '/workspace/preview') {
    const meta = {conversation_id: id, path, name, modified_ms: MODIFIED, downloadable: true};
    if (FILES[path] !== undefined) json(res, 200, {...meta, size: Buffer.byteLength(FILES[path]), preview: {kind: 'text', text: FILES[path], truncated: false}});
    else if (path === 'chart.png') json(res, 200, {...meta, size: PIXEL.length, preview: {kind: 'image', media_type: 'image/png'}});
    else json(res, 404, {code: 'workspace_not_found', message: 'No such file or folder'});
    return true;
  }
  if (rest === '/workspace/file') {
    const bytes = path === 'chart.png' ? PIXEL : FILES[path] !== undefined ? Buffer.from(FILES[path]) : null;
    if (!bytes) {
      json(res, 404, {code: 'workspace_not_found', message: 'No such file or folder'});
      return true;
    }
    const inline = q.get('inline') === 'true';
    res.writeHead(200, {'content-type': inline ? 'image/png' : 'application/octet-stream', 'content-length': bytes.length,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'});
    res.end(bytes);
    return true;
  }
  return false;
}
