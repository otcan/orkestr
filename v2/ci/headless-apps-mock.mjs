// Synthetic /api/v2/app-links for the CI browser tests: the owner's tools and
// apps as the host lists them (docs/v2/app-links.md), with example hosts only.
// Nothing is served at those hosts and the tests never open them.

export function appLinksState() {
  return {
    configured: true,
    links: [
      { id: 'vault', title: 'Vault (passwords)', url: 'https://vault.example.com/ui/', group: 'Tools',
        description: 'Passwords, tokens and API keys.', hint: 'Sign in with OIDC (your Orkestr login)' },
      { id: 'ops', title: 'Ops dashboard', url: 'https://ops.apps.example.com/', group: 'Dashboards',
        description: 'Timers and services on the host.', hint: null },
      { id: 'crm', title: 'Synthetic CRM app', url: 'https://crm.apps.example.com/', group: 'Apps',
        description: null, hint: null },
    ],
  };
}

export async function appLinksApi(state, req, res, url, { json }) {
  if (url.pathname !== '/api/v2/app-links') return false;
  if (req.method !== 'GET') {
    json(res, 405, { code: 'method_not_allowed', message: 'Method not allowed' });
    return true;
  }
  state.appLinksReads = (state.appLinksReads ?? 0) + 1;
  // An older server without the route.
  if (state.appLinksMissing) {
    json(res, 404, { code: 'not_found', message: 'Endpoint not found' });
    return true;
  }
  json(res, 200, state.appLinks ??= appLinksState());
  return true;
}
