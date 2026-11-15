// Synthetic /api/v2/sites for the CI browser tests (ORK-834): the catalog the
// host's publishing tool writes, with example hosts only. Nothing is served
// at those hosts and the tests never open them.
// The synthetic chats of headless-workspace-mock.mjs (Assistant, Research notes,
// Queued errands); repeated here so the two mocks do not import each other.
const A = '00000000-0000-4000-8000-00000000000a';
const C = '00000000-0000-4000-8000-00000000000c';

const MINUTE = 60_000;

export function sitesState(now = Date.now()) {
  const site = (slug, title, chat, ago, extra = {}) => ({ slug, title, url: `https://${slug}.sites.example.com/`, kind: 'static',
    conversation_id: chat, published_at_ms: now - ago, version: 'v0001', versions: 1, status: 'live', ...extra });
  return {
    configured: true,
    sites: [
      site('notes', 'Synthetic notes', A, 5 * MINUTE, { version: 'v0003', versions: 3 }),
      site('crm', 'Synthetic CRM', null, 2 * 60 * MINUTE, { kind: 'app', version: null, versions: 0 }),
      site('errands', 'Errands board', C, 24 * 60 * MINUTE, { version: 'v0002', versions: 2 }),
      site('old-notes', '', A, 3 * 24 * 60 * MINUTE, { status: 'disabled' }),
    ],
  };
}

export async function sitesApi(state, req, res, url, { json }) {
  if (url.pathname !== '/api/v2/sites') return false;
  if (req.method !== 'GET') {
    json(res, 405, { code: 'method_not_allowed', message: 'Method not allowed' });
    return true;
  }
  state.sitesReads = (state.sitesReads ?? 0) + 1;
  json(res, 200, state.siteCatalog ??= sitesState());
  return true;
}
