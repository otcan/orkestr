// CI-only form and lost-response check against synthetic browser responses.
import assert from 'node:assert/strict';
import { A } from './headless-workspace-mock.mjs';

export async function providerHandoff({ page, state, label, openDrawer, choose, clickText, waitText, screenshot, noHorizontalScroll }) {
  const prior = { settings: structuredClone(state.settings), window: structuredClone(state.window[A]) };
  const intakeCount = state.intakePosts.length, windowCount = state.windowPosts.length;
  const posts = [], headers = [], failures = [];
  const window = { ...state.window[A], state: 'closed' };
  assert.ok(window.window_id, 'scenario starts with an existing synthetic window');
  state.window[A] = window;
  const respond = (request, status, body) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const intercept = async request => {
    try {
      if (new URL(request.url()).pathname !== `/api/v2/conversations/${A}/provider-handoffs`) return await request.continue();
      const input = JSON.parse(request.postData());
      posts.push(input); headers.push(request.headers());
      if (posts.length === 1) {
        state.settings = { ...state.settings, provider: input.target_provider, model: input.model,
          reasoning_effort: input.reasoning_effort, revision: prior.settings.revision + 1, provider_generation: prior.settings.provider_generation + 1 };
        return await respond(request, 503, { code: 'provider_handoff_uncertain', message: 'Synthetic lost response after commit' });
      }
      return await respond(request, 200, { handoff_id: '00000000-0000-4000-8000-000000009001', conversation_id: A,
        window_id: window.window_id, generation: window.generation, from_provider: prior.settings.provider,
        to_provider: input.target_provider, settings_revision: state.settings.revision,
        provider_generation: state.settings.provider_generation, history_sha256: 'a'.repeat(64), created_at_ms: 1000 });
    } catch (error) { failures.push(error); await request.abort(); }
  };
  await page.setRequestInterception(true);
  page.on('request', intercept);
  try {
    await openDrawer(label); await choose('Assistant');
    await page.waitForSelector('#composer'); await clickText('Settings');
    await clickText('Change provider with context');
    await page.waitForSelector('.provider-handoff textarea');
    await waitText(`Current provider: ${prior.settings.provider}`);
    await waitText(window.window_id);
    await page.type('.provider-handoff textarea', 'Synthetic reviewed history. No actions to replay.');
    await clickText('Change provider');
    await waitText('confirm the new session');
    assert.equal(posts.length, 0, 'review confirmation is required before sending');
    await page.click('.provider-handoff input[type="checkbox"]');
    await clickText('Change provider');
    await waitText('Outcome unknown. Retry keeps exactly the same change and summary.');
    assert.equal(await page.$eval('.provider-handoff textarea', n => n.disabled), true, 'uncertain request cannot be edited');
    await screenshot(label, 'provider-handoff-uncertain');
    await noHorizontalScroll();
    await clickText('Retry same change');
    await waitText('Provider changed. History summary saved; no work started');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], posts[0], 'retry retains the exact key, window proof and reviewed summary');
    assert.equal(posts[0].expected_settings_revision, prior.settings.revision);
    assert.equal(posts[0].window_id, window.window_id);
    assert.equal(posts[0].generation, window.generation);
    assert.equal(posts[0].target_provider, 'claude');
    assert.equal(posts[0].acknowledge_new_native_session, true);
    assert.ok(headers.every(h => h['x-orkestr-csrf'] === 'synthetic-csrf' && !h.authorization));
    assert.equal(state.intakePosts.length, intakeCount, 'handoff creates no input');
    assert.equal(state.windowPosts.length, windowCount, 'handoff opens no work window');
    assert.deepEqual(failures, []);
    await screenshot(label, 'provider-handoff-complete');
    await clickText('Chat');
  } finally {
    page.off('request', intercept); await page.setRequestInterception(false);
    state.settings = prior.settings; state.window[A] = prior.window;
  }
}
