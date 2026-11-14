// Synthetic /api/v2/credentials for the CI browser tests (ORK-826). Fake ids,
// fake sites and fake values only; it behaves like the OpenBao store: values
// go in and never come back, every change names the revision it saw.
// The synthetic chats of headless-workspace-mock.mjs (Assistant, Research notes,
// Queued errands); repeated here so the two mocks do not import each other.
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const MINUTE = 60_000;
export const SECRET = 'synthetic-secret-value-42';

export function credentialsState(now = Date.now()) {
  const used = (by, ago, extra = {}) => ({ last_used_at_ms: now - ago, last_used_by: by, chats: [{ id: by, last_at_ms: now - ago, uses: 3 }], status: 'ok', status_at_ms: null, status_detail: null, ...extra });
  return {
    posts: [], patches: [], puts: [], deletes: [], clock: 1,
    rows: [
      { id: 'synthetic-search', label: 'Synthetic search API', type: 'api_key', site: 'search.example.invalid', allowed: [A, B], owner_desks: false,
        revision: '1:t1', updated_at_ms: null, fields: [], usage: { ...used(B, 5 * MINUTE), chats: [{ id: B, last_at_ms: now - 5 * MINUTE, uses: 3 }, { id: A, last_at_ms: now - 90 * MINUTE, uses: 1 }] } },
      { id: 'synthetic-portal', label: 'Synthetic portal', type: 'password', site: 'portal.example.invalid', allowed: [], owner_desks: true,
        revision: '2:t2', updated_at_ms: null, fields: [], usage: used(C, 3 * 60 * MINUTE, { status: 'failed', status_at_ms: now - 3 * 60 * MINUTE, status_detail: 'login_failed' }) },
      { id: 'synthetic-government', label: 'Synthetic government login', type: 'password', site: 'gov.example.invalid', allowed: [A], owner_desks: true,
        revision: '1:t3', updated_at_ms: null, fields: [], usage: used(A, 2 * 24 * 60 * MINUTE, { status: 'needs_2fa', status_at_ms: now - MINUTE, status_detail: 'code_required' }) },
      { id: 'synthetic-ci-token', label: 'Synthetic CI token', type: 'token', site: '', allowed: [], owner_desks: false,
        revision: '1:t4', updated_at_ms: null, fields: [], usage: { last_used_at_ms: null, last_used_by: null, chats: [], status: 'never_used', status_at_ms: null, status_detail: null } },
    ],
  };
}

const capabilities = {
  types: ['password', 'token', 'api_key'], grant_ids: 'conversation', owner_desks_editable: true, site_with_value: false,
  value_replace: 'fields', reveal: 'external', reveal_url: 'https://bao.example.invalid/ui/vault/secrets/orkestr/kv/creds%2F{id}', vault_import: false,
};
const slug = label => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'credential';

export async function credentialsApi(state, req, res, url, { json, body }) {
  const path = url.pathname;
  if (path !== '/api/v2/credentials' && !path.startsWith('/api/v2/credentials/')) return false;
  const store = state.credentialStore ??= credentialsState();
  const now = Date.now();
  if (req.method !== 'GET' && req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') {
    json(res, 403, { code: 'csrf', message: 'CSRF required' });
    return true;
  }
  const sorted = () => [...store.rows].sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  if (path === '/api/v2/credentials' && req.method === 'GET') {
    json(res, 200, { schema_version: 1, backend: 'openbao', capabilities, credentials: sorted(), truncated: false, catalog_at_ms: now,
      usage: { observed_at_ms: now - 30_000, stale: false } });
    return true;
  }
  if (path === '/api/v2/credentials' && req.method === 'POST') {
    const request = JSON.parse(await body(req) || '{}');
    store.posts.push(request);
    let id = slug(request.label), n = 2;
    while (store.rows.some(r => r.id === id)) id = `${slug(request.label)}-${n++}`;
    const row = { id, label: request.label, type: request.type, site: String(request.site || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
      allowed: request.allowed || [], owner_desks: !!request.owner_desks, revision: `1:n${store.clock++}`, updated_at_ms: now, fields: [],
      usage: { last_used_at_ms: null, last_used_by: null, chats: [], status: 'never_used', status_at_ms: null, status_detail: null } };
    store.rows.push(row);
    json(res, 201, row);
    return true;
  }
  const match = path.match(/^\/api\/v2\/credentials\/([a-z0-9-]+)(\/value)?$/);
  const row = match && store.rows.find(r => r.id === match[1]);
  if (!row) {
    json(res, 404, { code: 'credential_not_found', message: 'Credential not found' });
    return true;
  }
  const stale = () => json(res, 409, { code: 'credential_changed', message: 'This credential changed meanwhile; reload and try again' });
  if (req.method === 'DELETE' && !match[2]) {
    const expected = url.searchParams.get('expected_revision');
    if (expected !== row.revision) { stale(); return true; }
    store.deletes.push({ id: row.id, expected_revision: expected });
    store.rows = store.rows.filter(r => r !== row);
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  const request = JSON.parse(await body(req) || '{}');
  if (request.expected_revision !== row.revision) { stale(); return true; }
  if (req.method === 'PATCH' && !match[2]) {
    store.patches.push({ id: row.id, ...request });
    for (const key of ['label', 'site', 'allowed', 'owner_desks']) if (key in request) row[key] = request[key];
  } else if (req.method === 'PUT' && match[2]) {
    store.puts.push({ id: row.id, ...request });
  } else {
    json(res, 405, { code: 'method', message: 'Method not allowed' });
    return true;
  }
  row.revision = `${Number(row.revision.split(':')[0]) + 1}:u${store.clock++}`;
  json(res, 200, row);
  return true;
}
