// Browser setup for an unconfigured Orkestr container. Talks only to
// same-origin /api/v2 (session cookie + CSRF); shows the provider's own link
// and one-time code, never tokens.
'use strict';
const $ = (id) => document.getElementById(id);
let csrf = null;
let finishing = false;

async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['x-orkestr-csrf'] = csrf;
  const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body) });
  let value = {};
  try { value = await response.json(); } catch { value = {}; }
  return { status: response.status, value };
}

// A refusal stays visible for a few seconds instead of being replaced by the next poll.
let sticky = null;
function notice(text) {
  if (sticky && Date.now() < sticky.until) return;
  $('notice').textContent = text;
}
function flash(text) { sticky = null; notice(text); sticky = { until: Date.now() + 8000 }; }
function minutes(seconds) { return Math.max(1, Math.round(seconds / 60)) + ' min'; }
const ERRORS = {
  rate_limited: 'Please wait 30 seconds before starting another sign-in.',
  login_in_progress: 'A sign-in is already in progress.',
  already_signed_in: 'Already signed in.',
  credentials_refused: 'That Orkestr username or password is not right.',
  owner_mismatch: 'Use the same Orkestr account you are signed in with.',
  provider_login_required: 'Sign in to Codex first.',
  code_refused: 'That code was not accepted. Copy it again from the Claude page.',
  csrf_rejected: 'Your session changed. Reload this page.',
};
function explain(result) { return ERRORS[result.value.error] || 'Setup request refused (' + result.status + ').'; }

function provider(name, data) {
  const login = data.login;
  const active = login && (login.state === 'waiting' || login.state === 'verifying');
  const failed = login && ['failed', 'expired'].includes(login.state);
  $(name + '-state').textContent = data.signed_in ? 'signed in' : active ? 'waiting for you' :
    login && login.state === 'starting' ? 'starting…' : failed && login.reason === 'upstream_rate_limited' ? 'the provider is limiting sign-ins; try again in a few minutes' :
    failed ? 'sign-in did not finish; try again' : 'not signed in';
  $(name + '-start').hidden = data.signed_in || active;
  $(name + '-device').hidden = data.signed_in || !active;
  if (active) {
    const link = $(name + '-link');
    if (link.href !== login.link) link.href = login.link;
    if (name === 'codex') {
      link.textContent = login.link;
      $('codex-code').textContent = login.code;
      $('codex-expires').textContent = minutes(login.expires_in);
    }
  }
}

async function refresh() {
  if (finishing) return waitForRestart();
  const result = await call('GET', '/api/v2/oss-setup/status');
  if (result.status === 401) {
    $('signin').hidden = false; ['codex', 'claude', 'finish'].forEach((id) => { $(id).hidden = true; });
    return notice('Not signed in.');
  }
  if (result.status === 410 || result.status === 404 || result.status === 502) {
    notice('Models are connected. Opening Orkestr…');
    return setTimeout(() => { location.href = '/'; }, 1500);
  }
  if (result.status !== 200) return notice('Setup is unavailable (' + result.status + '). Reload to try again.');
  const value = result.value;
  $('signin').hidden = true; $('codex').hidden = false; $('claude').hidden = false;
  provider('codex', value.providers.codex);
  provider('claude', value.providers.claude);
  $('finish').hidden = !value.providers.codex.signed_in;
  if (value.configuring) { finishing = true; return waitForRestart(); }
  notice(value.error ? 'Activation refused: ' + value.error :
    value.providers.codex.signed_in ? 'Codex is signed in. Finish below (Claude is optional).' :
    'Start with Codex.');
}

async function waitForRestart() {
  notice('Activating models… this page reloads when Orkestr is ready.');
  try {
    const result = await call('GET', '/api/v2/oss-setup/status');
    if (result.status === 200 && result.value.error && !result.value.configuring) {
      finishing = false; return refresh();
    }
    if (result.status === 410 || result.status === 404) {
      const health = await call('GET', '/api/v2/health');
      if (health.status === 200) { location.href = '/'; return; }
    }
  } catch { /* restarting */ }
}

async function start(name) {
  $(name + '-button').disabled = true;
  const result = await call('POST', '/api/v2/oss-setup/login/' + name + '/start', {});
  $(name + '-button').disabled = false;
  if (result.status !== 202) flash(explain(result));
  refresh();
}

async function cancel(name) {
  await call('POST', '/api/v2/oss-setup/login/' + name + '/cancel', {});
  refresh();
}

async function init() {
  const session = await call('GET', '/api/v2/browser/session');
  if (session.status === 200) csrf = session.value.csrf_token;
  $('codex-button').addEventListener('click', () => start('codex'));
  $('claude-button').addEventListener('click', () => start('claude'));
  $('codex-cancel').addEventListener('click', () => cancel('codex'));
  $('claude-cancel').addEventListener('click', () => cancel('claude'));
  $('claude-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await call('POST', '/api/v2/oss-setup/login/claude/code', { code: $('claude-code').value.trim() });
    $('claude-code').value = '';
    if (result.status !== 202) flash(explain(result));
    refresh();
  });
  $('finish-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('finish-button').disabled = true;
    const result = await call('POST', '/api/v2/oss-setup/configure',
      { username: $('username').value, password: $('password').value });
    $('password').value = '';
    $('finish-button').disabled = false;
    if (result.status === 202) { finishing = true; return waitForRestart(); }
    flash(explain(result));
  });
  await refresh();
  setInterval(refresh, 3000);
}

init();
