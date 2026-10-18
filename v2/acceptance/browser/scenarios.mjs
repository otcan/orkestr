import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { click, digest, fill, secret, text, value, waitFor } from './support.mjs';

const DRAFT = 'Synthetic unsent draft; keep this text across navigation and reconnect.';
const rows = (page) => page.$$eval('section[aria-label="Accepted input history"] ol li', (items) => items.length);
const resourceValues = (page) => page.$$eval('section[aria-label="Host resources"] dd', (items) => items.map((item) => item.textContent));

async function setup(page, candidate, credentials) {
  await page.waitForSelector('#username', { visible: true });
  await click(page, 'First-time setup');
  await fill(page, '#username', credentials.username);
  await fill(page, '#password', credentials.password);
  await fill(page, '#bootstrap', candidate.bootstrap);
  await click(page, 'Continue');
  await page.waitForSelector('#composer', { visible: true });
  return page.evaluate(async () => {
    const response = await fetch('/api/v2/browser/session', { credentials: 'same-origin' });
    if (response.status !== 200) throw new Error('synthetic_browser_session_failed');
    return (await response.json()).global_conversation_id;
  });
}

export async function scenarios({ page, context, candidate, network, report, output, signal }) {
  const credentials = { username: 'synthetic-owner-a', password: secret() };
  let conversation;
  const step = async (name, action) => {
    signal.throwIfAborted();
    report.stage = name;
    process.stdout.write(`${JSON.stringify({ phase: name, state: 'running' })}\n`);
    const started = performance.now();
    const evidence = await action();
    signal.throwIfAborted();
    report.checks.push({ name, status: 'passed', duration_ms: Math.round(performance.now() - started), ...evidence });
  };

  await step('browser_setup_and_cookie', async () => {
    network.execution = 'hold';
    const started = performance.now();
    await page.goto(candidate.origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { visible: true });
    const coldReadyMs = Math.round(performance.now() - started);
    conversation = await setup(page, candidate, credentials);
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === 'orkestr_v2_session');
    assert(session?.httpOnly && session.sameSite === 'Strict' && session.path === '/api/v2', 'browser_cookie_flags');
    return { cold_signin_ready_ms: coldReadyMs, real_browser_cookie: true };
  });

  await step('draft_while_execution_read_pending', async () => {
    await waitFor(() => network.heldExecution.length > 0, 'execution_poll_not_observed');
    const started = performance.now();
    await fill(page, '#composer', DRAFT);
    const editingMs = Math.round(performance.now() - started);
    assert.equal(await value(page, '#composer'), DRAFT, 'draft_changed_during_poll');
    assert(editingMs < 2000, 'composer_edit_latency_exceeded');
    network.execution = 'real';
    await network.release('heldExecution');
    const status = await page.evaluate(async (id) => (await fetch(`/api/v2/conversations/${id}/execution`)).status, conversation);
    assert.equal(status, 204, 'ordinary_execution_idle_route_required');
    await waitFor(() => network.executionReads >= 3, 'execution_poll_did_not_continue');
    assert.equal(await value(page, '#composer'), DRAFT, 'draft_changed_after_poll');
    return { editing_ms: editingMs, execution_reads: network.executionReads, native_idle_status: status };
  });

  await step('navigation_and_reconnect_preserve_draft', async () => {
    await click(page, 'Projects');
    await page.waitForSelector('#project-name', { visible: true });
    await click(page, 'Assistant');
    await page.waitForSelector('#composer', { visible: true });
    assert.equal(await value(page, '#composer'), DRAFT, 'draft_lost_after_navigation');
    const previousComposer = await page.$('#composer');
    await click(page, 'Reconnect and reload history');
    await page.waitForFunction((previous) => !previous.isConnected, {}, previousComposer);
    await previousComposer.dispose();
    await page.waitForSelector('#composer', { visible: true });
    assert.equal(await value(page, '#composer'), DRAFT, 'draft_lost_after_reconnect');
  });

  await step('seed_10000_synthetic_history_messages', async () => {
    await click(page, 'History');
    await text(page, 'Conversation history');
    await waitFor(async () => (await rows(page)) === 0, 'empty_history_not_ready');
    return candidate.seedHistory(credentials, conversation);
  });

  await step('bounded_10000_history_page_and_interaction', async () => {
    const before = network.snapshots.length;
    const started = performance.now();
    await click(page, 'Refresh page');
    await waitFor(async () => (await rows(page)) === 100, 'history_first_page_not_rendered');
    const firstPageMs = Math.round(performance.now() - started);
    const firstText = await page.$eval('section[aria-label="Accepted input history"] ol li', (item) => item.textContent);
    const frames = page.evaluate(() => new Promise((resolve) => {
      let previous = performance.now(); const intervals = [];
      const frame = (now) => {
        intervals.push(now - previous); previous = now;
        if (intervals.length === 30) resolve(Math.max(...intervals)); else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    const nextStarted = performance.now();
    await click(page, 'Next 100');
    await page.waitForFunction((old) => {
      const items = document.querySelectorAll('section[aria-label="Accepted input history"] ol li');
      return items.length === 100 && items[0].textContent !== old;
    }, {}, firstText);
    const nextPageMs = Math.round(performance.now() - nextStarted);
    const maximumFrameMs = Math.round(await frames);
    await delay(100);
    const pages = network.snapshots.slice(before);
    assert(pages.length >= 2 && pages.length <= 3, 'history_fetched_more_than_requested_pages');
    assert(pages.every((item) => item.messages === 100 && item.bytes <= 64 * 1024), 'history_page_unbounded');
    assert(firstPageMs < 2000 && nextPageMs < 2000, 'history_page_latency_exceeded');
    assert(maximumFrameMs < 250, 'history_blocked_browser_rendering');
    await click(page, 'Assistant');
    await page.waitForSelector('#composer', { visible: true });
    const editStarted = performance.now();
    await fill(page, '#composer', `${DRAFT} Still editable with 10000 stored messages.`);
    const editingMs = Math.round(performance.now() - editStarted);
    assert(editingMs < 2000, 'large_history_blocked_composer');
    return { stored_messages: 10_000, maximum_rendered_rows: 100, first_page_ms: firstPageMs,
      next_page_ms: nextPageMs, maximum_animation_frame_ms: maximumFrameMs, editing_ms: editingMs,
      page_reads: pages.length, maximum_page_bytes: Math.max(...pages.map((item) => item.bytes)) };
  });

  await step('resources_unavailable_then_measured', async () => {
    network.resources = 'unavailable';
    await click(page, 'Host resources');
    await text(page, 'Host resources unavailable. Retrying');
    assert.deepEqual(await resourceValues(page), ['Unavailable', 'Unavailable'], 'missing_resources_fabricated');
    network.resources = 'real';
    await text(page, 'Host resources current', 15_000);
    await waitFor(() => network.resourceSample?.availability === 'ready', 'native_resource_sample_missing');
    const measured = await resourceValues(page);
    assert(/% busy$/.test(measured[0]) && /MiB used/.test(measured[1]), 'measured_resources_not_rendered');
    await page.screenshot({ path: `${output}/resources-measured.png`, fullPage: true });
    return { native_route: true, unavailable_did_not_become_zero: true };
  });

  await step('cached_resource_samples_expire_across_remount', async () => {
    const sampleHash = digest(JSON.stringify(network.resourceSample));
    network.resources = 'cached';
    const before = network.resourcesReads;
    const started = performance.now();
    await text(page, 'Host resources stale. Reconnecting', 20_000);
    const staleMs = Math.round(performance.now() - started);
    assert(staleMs >= 10_000 && staleMs <= 19_000, 'cached_sample_did_not_age_normally');
    assert(network.resourcesReads - before >= 5, 'cached_response_replay_not_exercised');
    assert.deepEqual(await resourceValues(page), ['Unavailable', 'Unavailable'], 'stale_measurements_fabricated');
    await click(page, 'Settings');
    await click(page, 'Host resources');
    await delay(2500);
    await text(page, 'Host resources stale. Reconnecting');
    assert.deepEqual(await resourceValues(page), ['Unavailable', 'Unavailable'], 'remount_rejuvenated_stale_sample');
    await page.screenshot({ path: `${output}/resources-stale.png`, fullPage: true });
    return { fixture: 'replayed_native_sample', sample_sha256: sampleHash, stale_after_ms: staleMs };
  });

  await step('pending_logout_fences_reauthentication', async () => {
    network.resources = 'real';
    await text(page, 'Host resources current', 10_000);
    network.logout = 'hold';
    await click(page, 'Sign out');
    await waitFor(() => network.heldLogout.length === 1, 'logout_request_not_held');
    network.resources = 'unauthorized';
    await text(page, 'Finishing sign-out before another sign-in', 10_000);
    assert.equal(await page.$('#username'), null, 'login_available_while_old_logout_pending');
    network.logout = 'real';
    await network.release('heldLogout');
    await page.waitForSelector('#username', { visible: true });
    const status = await page.evaluate(async () => (await fetch('/api/v2/browser/session')).status);
    assert.equal(status, 401, 'logout_did_not_revoke_server_session');
    assert(!(await context.cookies()).some((cookie) => cookie.name === 'orkestr_v2_session'), 'logout_cookie_not_cleared');
    return { delayed_real_logout: true, expired_read_during_logout: true, server_session_revoked: true };
  });

  await step('new_owner_has_no_old_draft_or_resource_cache', async () => {
    await candidate.stop();
    candidate.bootstrap = secret();
    await candidate.start('owner-b');
    network.resources = 'unavailable';
    const second = await setup(page, candidate, { username: 'synthetic-owner-b', password: secret() });
    assert.notEqual(second, conversation, 'new_synthetic_owner_not_distinct');
    assert.equal(await value(page, '#composer'), '', 'old_owner_draft_leaked');
    assert(!(await page.evaluate(() => document.body.innerText)).includes(DRAFT), 'old_owner_text_leaked');
    await click(page, 'Host resources');
    await text(page, 'Host resources unavailable. Retrying');
    assert.deepEqual(await resourceValues(page), ['Unavailable', 'Unavailable'], 'old_owner_resource_cache_leaked');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer', { visible: true });
    assert.equal(await value(page, '#composer'), '', 'owner_resume_restored_old_draft');
    return { fixture: 'fresh_synthetic_server_namespace_same_origin', browser_cookie_resume: true };
  });

  assert.equal(network.externalRequests, 0, 'unexpected_external_browser_request');
  assert.equal(network.getAuthorityHeaders, 0, 'browser_get_sent_authority_header');
  report.network = { request_kinds: network.requestKinds, external_requests: network.externalRequests,
    get_authority_headers: network.getAuthorityHeaders, intercepted_cancellations: network.interceptedFailures };
}
