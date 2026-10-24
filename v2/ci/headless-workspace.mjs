// CI-only rendering of the configured beta workspace against a synthetic API.
// Exercises the real WASM bundle at desktop and phone widths; no provider runs.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { A, C, V1_INSTANCE_REF, V1_LINKS, V1_WORKER, createState, startMock } from './headless-workspace-mock.mjs';
import { mkdir } from 'node:fs/promises';
import { providerHandoff } from './headless-provider-handoff.mjs';
import { trackerScenario } from './headless-tracker.mjs';

assert.equal(process.env.CI, 'true', 'Run only in isolated CI');
assert.ok(process.env.UI_BUNDLE_DIR, 'UI_BUNDLE_DIR is required');
const { server, state, origin } = await startMock(process.env.UI_BUNDLE_DIR);
const errors = [];
let browser, page, stage = 'startup';
const text = selector => page.$eval(selector, node => node.textContent);
const waitText = (snippet, timeout = 15000) => page.waitForFunction(s => document.body.textContent.includes(s), { timeout }, snippet);
const clickText = async label => {
  const found = await page.evaluate(label => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click(); return true;
  }, label);
  assert.ok(found, `Missing button: ${label}`);
};
const openDrawer = async label => {
  if (label !== 'phone') return;
  await page.click('.threads-toggle');
  await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebarOpen === 'true');
};
const rowText = async (name, selector) => page.evaluate((name, selector) => {
  const row = [...document.querySelectorAll('.conversation-row')].find(r => r.querySelector('.conversation-name')?.textContent === name);
  return row?.querySelector(selector)?.textContent ?? null;
}, name, selector);
const choose = name => page.evaluate(name => [...document.querySelectorAll('.conversation-choice')]
  .find(b => b.querySelector('.conversation-name')?.textContent === name).click(), name);
const screenshot = async (label, name) => {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${label}-${name}.png` });
};
const clickWithin = async (scope, label) => {
  const found = await page.evaluate((scope, label) => {
    const button = [...document.querySelectorAll(`${scope} button`)].find(b => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click(); return true;
  }, scope, label);
  assert.ok(found, `Missing button in ${scope}: ${label}`);
};
const noHorizontalScroll = async () => {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width, `Horizontal page scroll at ${width}px (${scroll}px content)`);
};

// Wait for the synthetic server state (not the page) to satisfy `check`.
const until = async (check, what, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};
const composerValue = id => page.$eval(id, n => n.value);
// Start a reply: hover + Reply on desktop, a long press on the phone.
const replyTo = async (label, rowSelector, snippet) => {
  const handle = await page.evaluateHandle((rowSelector, snippet) => [...document.querySelectorAll(rowSelector)]
    .find(li => li.textContent.includes(snippet) && li.dataset.replyable === 'true'), rowSelector, snippet);
  const row = handle.asElement();
  assert.ok(row, `Replyable row with ${snippet}`);
  await row.evaluate(li => li.scrollIntoView({ block: 'center' }));
  if (label === 'phone') {
    const text = await row.$('article .rich-text') ?? await row.$('article p');
    const box = await text.boundingBox();
    await page.touchscreen.touchStart(box.x + 5, box.y + box.height / 2);
    await new Promise(r => setTimeout(r, 750));
    await page.touchscreen.touchEnd();
  } else {
    await row.hover();
    assert.ok(await row.$eval('.reply-action', b => getComputedStyle(b).opacity !== '0'), 'Reply shows on hover');
    await row.$eval('.reply-action', b => b.click());
  }
};

const transcript = () => page.$eval('.conversation-pane > .conversation-scroll', el =>
  ({ gap: el.scrollHeight - el.scrollTop - el.clientHeight, pinned: el.dataset.pinned, scrollable: el.scrollHeight > el.clientHeight + 100 }));

export const scenarios = [
  ['tracker-guided', async label => trackerScenario({page,state,conversation:A,label,screenshot})],
  ['composer-tools', async label => {
    await page.waitForSelector('#composer');
    // Enter sends; Shift+Enter inserts a newline; IME composition never sends.
    const posts = () => Object.keys(state.intake).length;
    const before = posts();
    await page.focus('#composer');
    await page.keyboard.type('Synthetic first line');
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
    await page.keyboard.type('second line');
    assert.equal(await page.$eval('#composer', n => n.value), 'Synthetic first line\nsecond line');
    assert.equal(posts(), before, 'Shift+Enter does not send');
    await page.$eval('#composer', n => n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(posts(), before, 'Enter during IME composition does not send');
    // Attach an image through the file picker and paste long text as a file.
    const file = '/tmp/orkestr-v2-synthetic-pixel.png';
    await import('node:fs/promises').then(fs => fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')));
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.message-composer .tool-button')]);
    await chooser.accept([file]);
    await page.waitForFunction(() => document.querySelector('.attachment-chip .chip-name')?.textContent === 'orkestr-v2-synthetic-pixel.png');
    await clickText('Paste text');
    await page.type('#paste-text', 'Synthetic long pasted text');
    await clickText('Attach as text file');
    await page.waitForFunction(() => document.querySelectorAll('.attachment-chip').length === 2);
    assert.match(await text('.composer-tools'), /pasted-text-\d{14}\.txt/);
    const uploads = state.uploads.filter(u => u.target === A);
    assert.equal(uploads.at(-2).files[0].media_type, 'image/png');
    assert.equal(Buffer.from(uploads.at(-1).files[0].content_base64, 'base64').toString(), 'Synthetic long pasted text');
    await screenshot(label, 'composer-attachments');
    await page.focus('#composer');
    await page.keyboard.press('Enter');
    await until(() => state.windowPosts.some(w => w.input_request_key === Object.keys(state.intake).at(-1)), 'work request of the sent message');
    assert.equal(posts(), before + 1, 'Enter sends once');
    const sent = state.messages[A].at(-1).text;
    assert.match(sent, /^Synthetic first line\nsecond line\n\n\[Files attached in the Orkestr app/);
    assert.match(sent, /orkestr-v2-synthetic-pixel\.png \(image\/png, \d+ bytes.*local file \/synthetic\/attachments\//);
    assert.equal(await page.$$eval('.attachment-chip', n => n.length), 0, 'Sent attachments leave the composer');
  }],
  ['drop-attachments', async label => {
    // Files dragged onto the conversation highlight it and attach on drop;
    // a pasted image attaches too. Both use the Attach upload.
    await page.waitForSelector('.message-composer .composer-tools[id]');
    const uploads = state.uploads.length;
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['first synthetic drop'], 'drop-one.txt', { type: 'text/plain' }));
      dt.items.add(new File(['second synthetic drop'], 'drop-two.md', { type: 'text/markdown' }));
      window.__drop = dt;
      document.querySelector('.conversation-pane').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      document.querySelector('.chat-transcript').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    assert.ok(await page.$('.conversation-pane.drop-active'), 'drop zone is highlighted');
    await screenshot(label, 'drop-highlight');
    await page.evaluate(() => document.querySelector('.chat-transcript').dispatchEvent(new DragEvent('drop', { dataTransfer: window.__drop, bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.querySelectorAll('.message-composer .attachment-chip').length === 2);
    assert.equal(await page.$('.conversation-pane.drop-active'), null);
    assert.deepEqual(state.uploads.at(-1).files.map(f => [f.filename, f.media_type]), [['drop-one.txt', 'text/plain'], ['drop-two.md', 'text/markdown']]);
    assert.equal(state.uploads.length, uploads + 1, 'one upload for one drop');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
      document.querySelector('#composer').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.message-composer .attachment-chip').length === 3);
    assert.equal(state.uploads.at(-1).files[0].media_type, 'image/png');
    await screenshot(label, 'drop-attached');
    // Over the limit: a clear error and nothing uploaded.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(17 * 1024 * 1024)], 'too-big.bin'));
      document.querySelector('.conversation-pane').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await waitText('Not attached: Attachments are limited to 16 MiB per message.');
    assert.equal(state.uploads.length, uploads + 2);
    while (await page.$('.message-composer .chip-remove')) await page.click('.message-composer .chip-remove');
  }],
  ['parallel-sends', async label => {
    // Several messages in a row: the composer is never disabled, each message
    // has its own key and state, order holds, and later ones join the running turn.
    await page.waitForSelector('#composer');
    const intakeBefore = state.intakePosts.length, windowBefore = state.windowPosts.length;
    state.windowDelayMs = 600;
    state.intakeLoseNext = true; // the first answer is lost; its retry must not duplicate
    for (const n of [1, 2, 3]) {
      await page.focus('#composer');
      await page.keyboard.type(`Parallel ${n}`);
      assert.equal(await page.$eval('#composer', el => el.disabled), false, 'composer stays enabled');
      assert.equal(await page.$eval('.message-composer button[type=submit]', el => el.disabled), false, 'Send stays enabled');
      await page.keyboard.press('Enter');
      assert.equal(await composerValue('#composer'), '', 'text leaves the composer at once');
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-delivery]').length >= 1);
    await screenshot(label, 'outbox-sending');
    await until(() => state.windowPosts.length >= windowBefore + 3, 'three work requests');
    state.windowDelayMs = 0;
    const mine = state.messages[A].filter(m => /^Parallel \d$/.test(m.text));
    assert.deepEqual(mine.map(m => m.text), ['Parallel 1', 'Parallel 2', 'Parallel 3'], 'one message each, in order');
    const keys = state.intakePosts.slice(intakeBefore).map(p => p.client_message_id);
    assert.equal(new Set(keys).size, 3, 'three distinct idempotency keys');
    assert.equal(keys.length, 4, 'the lost answer was retried once with the same key');
    assert.equal(keys[0], keys[1]);
    const windows = state.windowPosts.slice(windowBefore);
    assert.deepEqual(windows.map(w => w.input_request_key), [...new Set(keys)], 'work starts in send order');
    assert.ok(windows.slice(1).every(w => w.window_id !== null), 'later messages join the running turn');
    // Without a live event stream (synthetic API) sent messages stay as "Sent" bubbles.
    await page.waitForFunction(() => document.querySelectorAll('.outbox-message [data-delivery="sent"]').length >= 3 && !document.querySelector('[data-delivery="sending"], [data-delivery="failed"]'));
  }],
  ['replies', async label => {
    // Reply to an earlier message: it is quoted in the composer, sent with
    // reply-to context and the visible line the model reads, and shown quoted.
    await replyTo(label, '.chat-messages > li', 'Native synthetic message');
    await page.waitForFunction(() => document.querySelector('.composer-quote')?.textContent.includes('Native synthetic message'));
    assert.match(await text('.composer-quote cite'), /Replying to you/);
    await screenshot(label, 'reply-composer');
    await page.click('.composer-quote-cancel');
    await page.waitForFunction(() => !document.querySelector('.composer-quote'));
    await replyTo(label, '.chat-messages > li', 'Native synthetic message');
    await page.waitForSelector('.composer-quote');
    await page.focus('#composer');
    await page.keyboard.type('Synthetic reply');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.composer-quote'));
    await until(() => state.messages[A].at(-1).text.endsWith('Synthetic reply'), 'reply admitted');
    const sent = state.messages[A].at(-1);
    assert.equal(sent.text, '[Replying to your message: "Native synthetic message"]\n\nSynthetic reply');
    assert.deepEqual(sent.reply_to, { message_id: '00000000-0000-4000-8000-000000000101', author: 'owner', sent_at: null,
      text: 'Native synthetic message', is_own_reply: false, unavailable: false });
    await page.waitForFunction(() => [...document.querySelectorAll('.outbox-message')].some(li =>
      li.querySelector('.reply-quote')?.textContent.includes('Native synthetic message') && li.querySelector('.rich-text')?.textContent.trim() === 'Synthetic reply'));
    await screenshot(label, 'reply-sent');
    // Replying scrolled the quoted message into view; return to the newest.
    await page.$eval('.conversation-pane > .conversation-scroll', el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  }],
  ['message-times', async label => {
    // Native message: short Berlin time for an older day, full date on hover/tap.
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-messages .user-message')].some(li => li.textContent.includes('Native synthetic message') && li.querySelector('.message-time')), { timeout: 20000 });
    const native = () => page.evaluate(() => {
      const li = [...document.querySelectorAll('.chat-messages .user-message')].find(l => l.textContent.includes('Native synthetic message'));
      const button = li.querySelector('.message-time');
      return { text: button.textContent, title: button.title, details: li.querySelector('.message-time-details')?.textContent ?? null };
    });
    assert.deepEqual(await native(), { text: '1 Jul 2025, 16:42', title: 'Tue 1 Jul 2025, 16:42:05 CEST', details: null });
    await page.evaluate(() => [...document.querySelectorAll('.chat-messages .user-message')].find(l => l.textContent.includes('Native synthetic message')).querySelector('.message-time').click());
    await page.waitForFunction(() => document.querySelector('.message-time-details'));
    assert.equal((await native()).details, 'Tue 1 Jul 2025, 16:42:05 CEST', 'no receipts are invented for owner input');
    await screenshot(label, 'message-times');
  }],
  ['scroll-pin', async () => {
    // Opening a conversation shows the newest message.
    await page.waitForFunction(() => document.querySelectorAll('.archived-messages > li').length >= 50);
    await page.waitForFunction(() => {
      const el = document.querySelector('.conversation-pane > .conversation-scroll');
      return el && el.dataset.pinned === 'true' && el.scrollHeight - el.scrollTop - el.clientHeight <= 72;
    });
    assert.ok((await transcript()).scrollable, 'Synthetic transcript must overflow');
    // Scrolling up releases the pin and offers a jump back.
    await page.$eval('.conversation-pane > .conversation-scroll', el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelector('.conversation-pane > .conversation-scroll').dataset.pinned === 'false');
    assert.ok(await page.$eval('.jump-latest', b => getComputedStyle(b).display !== 'none'), 'Jump to latest is offered');
    await page.click('.jump-latest');
    await page.waitForFunction(() => document.querySelector('.conversation-pane > .conversation-scroll').dataset.pinned === 'true');
    assert.ok(await page.$eval('.jump-latest', b => getComputedStyle(b).display === 'none'));
  }],
  ['archived-history', async () => {
    await page.waitForSelector('.archived-history li');
    await page.waitForFunction(() => document.querySelectorAll('.archived-messages > li').length === 50);
    const order = await page.evaluate(() => {
      const archived = document.querySelector('.archived-history');
      const native = [...document.querySelectorAll('.conversation-scroll *')].find(n => n.textContent === 'Native synthetic message');
      return Boolean(archived && native && (archived.compareDocumentPosition(native) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.ok(order, 'Archived history must render before native messages');
    assert.match(await text('.archived-history > summary'), /50 loaded, more available/);
    await clickText('Load more imported history');
    await page.waitForFunction(() => document.querySelectorAll('.archived-messages > li').length === 60);
    assert.match(await text('.archived-history > summary'), /60 messages/);
  }],
  ['reload-recovery', async label => {
    const draft = () => composerValue('#composer');
    const typeDraft = async value => { await page.focus('#composer'); await page.keyboard.type(value); };
    // An unsent draft survives a full reload.
    await typeDraft('Draft survives reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#composer')?.value === 'Draft survives reload');
    // Intake succeeds, work admission stays uncertain: the message shows as
    // failed and retries by itself; a second message waits behind it.
    state.windowMode = 'uncertain';
    const windowBefore = state.windowPosts.length;
    await clickText('Send');
    assert.equal(await draft(), '', 'the composer is free at once');
    await typeDraft('Second while the first retries');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-delivery="failed"]'), { timeout: 20000 });
    await screenshot(label, 'outbox-failed');
    await until(() => state.windowPosts.length >= windowBefore + 2, 'automatic retries');
    const first = state.windowPosts.at(-1);
    assert.ok(state.windowPosts.slice(windowBefore).every(w => w.request_key === first.request_key), 'retries resend the same work request');
    const intakes = Object.keys(state.intake).length;
    // A reload keeps both unsent messages (localStorage) and their order.
    await typeDraft('Edit after sending');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-delivery]', { timeout: 20000 });
    assert.equal(await draft(), 'Edit after sending', 'newer edits are kept');
    state.windowMode = 'accept';
    await page.evaluate(() => [...document.querySelectorAll('.delivery-retry')][0]?.click());
    const second = () => state.messages[A].find(m => m.text === 'Second while the first retries');
    await until(() => second() && state.windowPosts.some(w => w.input_message_id === second().message_id), 'second message admitted');
    const posts = state.windowPosts.slice(windowBefore);
    assert.ok(posts.filter(w => w.input_message_id === first.input_message_id).every(w => w.request_key === first.request_key), 'the first keeps its request across the reload');
    assert.equal(posts.filter(w => w.input_message_id === second().message_id).length, 1, 'the second is admitted once');
    assert.ok(posts.findIndex(w => w.input_message_id === second().message_id) > posts.findLastIndex(w => w.input_message_id === first.input_message_id), 'order holds');
    assert.equal(Object.keys(state.intake).length, intakes + 1, 'no duplicate messages');
    await page.waitForFunction(() => !document.querySelector('[data-delivery="failed"]') && !document.querySelector('[data-delivery="sending"]'), { timeout: 20000 });
    await page.$eval('#composer', n => { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
  }],
  ['conversation-list', async label => {
    await openDrawer(label);
    await page.waitForFunction(() => document.querySelectorAll('.conversation-status').length >= 2, { timeout: 20000 });
    const badges = await page.$$eval('.conversation-choice', rows => Object.fromEntries(rows.map(r =>
      [r.querySelector('.conversation-name')?.textContent, r.querySelector('.conversation-status')?.textContent ?? ''])));
    assert.equal(badges['Research notes'], 'Working');
    assert.equal(badges['Queued errands'], 'Queued #2');
    assert.equal(await page.$('.slot-summary'), null, 'Work slot usage is not part of the chat UI');
    assert.ok(!(await page.evaluate(() => document.querySelector('.conversation-sidebar').textContent)).includes('work slots'));
    await page.evaluate(() => [...document.querySelectorAll('.conversation-choice')].find(b => b.textContent.includes('Research notes')).click());
    await page.waitForFunction(() => document.querySelector('.conversation-heading h2')?.textContent === 'Research notes');
    if (label === 'phone') assert.equal(await page.$eval('.workspace', n => n.dataset.sidebarOpen), 'false', 'Selecting closes the phone drawer');
    await page.waitForSelector('#composer');
  }],
  ['tabs', async () => {
    for (const [tab, expected] of [['Work', 'Provider'], ['Projects', 'Create project'], ['Timers', 'New timer'], ['Memory', 'Optional saved facts'], ['Chat', 'Message']]) {
      await clickText(tab);
      await waitText(expected);
    }
    await clickText('Work');
    await waitText('Codex');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => /^(Stop|Stop unavailable)$/.test(b.textContent.trim())));
    await waitText('Steer running work');
    // The linked V1 thread's workers: retired ones only on request.
    await waitText('Synthetic V1 worker progress');
    assert.ok(!(await page.evaluate(() => document.body.textContent)).includes('Synthetic V1 worker 3'), 'Retired V1 workers start hidden');
    assert.equal(await page.$eval('.v1-workers a', a => a.getAttribute('href')), '#v1/worker-synthetic-group-0001');
    await clickText('Show retired (1)');
    await waitText('Synthetic V1 worker 3 · retired');
    await clickText('Hide retired (1)');
    await clickText('Projects');
    await waitText('Git: not_configured');
    await clickText('Errand project');
    // A listed conversation keeps its directory name; otherwise the project name is shown.
    await page.waitForFunction(() => ['Errand project', 'Queued errands'].includes(document.querySelector('.conversation-heading h2')?.textContent));
    await page.waitForSelector('#composer');
    assert.ok(page.url().endsWith('#conversation/00000000-0000-4000-8000-00000000000c'), 'Project opens its conversation');
  }],
  ['live-map', async () => {
    await clickText('Live map');
    await waitText('Busy synthetic group');
    await waitText('Synthetic running agent');
    await waitText('Delegated to V2');
    await waitText('Research notes');
    const body = () => page.evaluate(() => document.querySelector('.live-map').textContent);
    assert.ok(!(await body()).includes('Quiet synthetic group'), 'Active only hides idle views');
    assert.ok(!(await body()).includes('Synthetic finished agent'), 'Active only hides finished agents');
    await noHorizontalScroll();
    await clickText('All');
    await waitText('Quiet synthetic group');
    await page.evaluate(() => document.querySelectorAll('.live-view details').forEach(d => { d.open = true; }));
    await waitText('Synthetic finished agent');
    await noHorizontalScroll();
    await clickText('Chat');
    await page.waitForSelector('#composer');
  }],
  ['sidebar', async label => {
    await openDrawer(label);
    await page.waitForFunction(() => document.querySelectorAll('.conversation-row').length >= 4, { timeout: 20000 });
    // Newest activity first: the V1 group carries its worker's newer activity.
    const order = await page.$$eval('.conversation-row[data-depth="0"] .conversation-name', n => n.map(x => x.textContent));
    assert.deepEqual(order, ['Synthetic group', 'Research notes', 'Assistant', 'Queued errands']);
    assert.equal(await rowText('Synthetic group', '.choice-time'), '1m');
    assert.equal(await rowText('Assistant', '.choice-time'), '1d');
    assert.match(await rowText('Synthetic group', '.choice-badges'), /On V1.*Coordinator/);
    assert.match(await rowText('Synthetic group', '.group-toggle'), /^1 ▸$/);
    // A parent with sub-chats stays aligned with every other top-level chat:
    // nothing indents it under the chat above.
    // V1 chats show their Orkestr icon from V1; native chats keep initials.
    await page.waitForFunction(() => [...document.querySelectorAll('.conversation-row[data-source=v1] img.avatar-icon')].every(i => i.complete && i.naturalWidth > 0)
      && document.querySelectorAll('.conversation-row[data-source=v1] img.avatar-icon').length >= 1);
    assert.match(await page.$eval('.conversation-row[data-source=v1] img.avatar-icon', i => i.getAttribute('src')), /^\/api\/v2\/thread-icons\/synthetic-group$/);
    assert.equal(await page.$$eval('.conversation-row[data-source=v2] img.avatar-icon', n => n.length), 0);
    const lefts = await page.$$eval('.conversation-row[data-depth="0"] .avatar', n => [...new Set(n.map(a => Math.round(a.getBoundingClientRect().left)))]);
    assert.equal(lefts.length, 1, `top-level avatars misaligned: ${lefts}`);
    assert.equal(await rowText('Research notes', '.choice-activity'), 'thinking… · 1 worker');
    // Unread replies until viewed; the open conversation (from Projects) is read.
    assert.equal(await rowText('Synthetic group', '.unread-badge'), '1');
    assert.equal(await rowText('Assistant', '.unread-badge'), null, 'Viewed at load');
    assert.equal(await rowText('Queued errands', '.unread-badge'), null, 'Open conversation');
    assert.equal(await rowText('Assistant', '.choice-preview'), 'Synthetic assistant answer');
    for (const id of [A, C]) assert.ok(state.marks.some(m => m.key === `v2:${id}`), 'Opening marks read on the server');
    // Sub-chats are collapsed under the parent until expanded.
    assert.equal(await page.$$eval('.conversation-row[data-depth="1"]', n => n.length), 0);
    await page.evaluate(() => [...document.querySelectorAll('.group-toggle')][0].click());
    await page.waitForFunction(() => document.querySelector('.conversation-row[data-depth="1"] .conversation-name')?.textContent === 'Synthetic group / Worker 1');
    await screenshot(label, 'sidebar');
    // The header shows live activity of the open conversation.
    await choose('Research notes');
    await page.waitForFunction(() => document.querySelector('.heading-activity')?.textContent === 'thinking… · 1 worker');
    // A linked V1 chat opens read-only with its recent history and badge.
    await openDrawer(label);
    await choose('Synthetic group');
    await page.waitForSelector('.v1-banner');
    await page.waitForSelector('.conversation-heading > img.avatar-icon');
    // V1 messages carry their time and the receipts V1 recorded.
    await page.waitForFunction(() => [...document.querySelectorAll('.v1-thread .chat-messages li')].some(l => l.textContent.includes('Synthetic coordinator reply') && l.querySelector('.message-time')));
    const v1reply = await page.evaluate(() => {
      const li = [...document.querySelectorAll('.v1-thread .chat-messages li')].find(l => l.textContent.includes('Synthetic coordinator reply'));
      const b = li.querySelector('.message-time'); b.click(); return { text: b.textContent, title: b.title };
    });
    assert.equal(v1reply.text, '1 Jul 2025, 16:42 ✓');
    assert.match(v1reply.title, /Tue 1 Jul 2025, 16:42:05 CEST\n✓ Sent to WhatsApp · Tue 1 Jul 2025, 16:42:09 CEST/);
    await page.waitForFunction(() => /✓ Sent to WhatsApp · 1 Jul 2025, 16:42/.test(document.querySelector('.v1-thread .message-time-details')?.textContent ?? ''));
    const v1owner = await page.evaluate(() => [...document.querySelectorAll('.v1-thread .chat-messages li')].find(l => l.textContent.includes('Synthetic owner question on V1')).querySelector('.receipt-mark') !== null);
    assert.equal(v1owner, false, 'owner messages carry no delivery mark');
    await page.waitForFunction(() => document.querySelectorAll('.v1-thread .chat-messages > li').length === 3);
    assert.match(await text('.v1-thread .chat-messages'), /Synthetic member note/);
    assert.equal(await page.$('#composer'), null, 'Linked V1 chats have no V2 composer');
    assert.match(await text('.heading-meta'), /On V1 · coordinator attached/);
    // Owner input into the V1 thread: an unknown first outcome is retried
    // with the same key, and V1 admits the message exactly once.
    await page.waitForSelector('#v1-composer');
    await page.type('#v1-composer', 'Synthetic owner note to V1');
    await clickText('Send');
    assert.equal(await composerValue('#v1-composer'), '', 'Text leaves the composer at once');
    // The unknown first outcome retries by itself with the same key.
    await until(() => state.v1Posts.length >= 2, 'automatic V1 retry');
    await screenshot(label, 'v1-chat-retry');
    assert.equal(state.v1Inputs.length, 1, 'Exactly one V1 input');
    assert.equal(state.v1Posts.length, 2);
    assert.equal(state.v1Posts[0].client_message_id, state.v1Posts[1].client_message_id, 'Retry reuses the key');
    assert.deepEqual({ ...state.v1Posts[0], client_message_id: 'k' },
      { thread: 'synthetic-group', client_message_id: 'k', text: 'Synthetic owner note to V1' });
    // V1 works on it (typing…), then the coordinator's reply appears live.
    await page.waitForSelector('.v1-typing');
    await screenshot(label, 'v1-chat-typing');
    await waitText('Synthetic coordinator answer', 20000);
    await page.waitForFunction(() => !document.querySelector('.v1-typing'));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.v1-thread .chat-messages strong')].at(-1).textContent), 'Coordinator');
    await screenshot(label, 'v1-chat');
    // Attach to the V1 chat: V1 upload ids travel with the input; Enter sends.
    const [v1chooser] = await Promise.all([page.waitForFileChooser(), page.click('.v1-composer .tool-button')]);
    await v1chooser.accept(['/tmp/orkestr-v2-synthetic-pixel.png']);
    await page.waitForSelector('.v1-composer .attachment-chip');
    await page.focus('#v1-composer');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.v1-composer .attachment-chip'));
    const v1post = state.v1Posts.at(-1);
    assert.equal(v1post.text, 'Attached: orkestr-v2-synthetic-pixel.png');
    assert.equal(v1post.attachment_ids.length, 1);
    assert.equal(state.uploads.at(-1).target, 'v1:synthetic-group');
    // Reply in the V1 chat: V1 gets the quote as the relay's reply line.
    await replyTo(label, '.v1-thread .chat-messages > li', 'Synthetic coordinator answer');
    await page.waitForFunction(() => document.querySelector('.v1-thread .composer-quote')?.textContent.includes('Replying to Orkestr'));
    await page.focus('#v1-composer');
    await page.keyboard.type('Synthetic V1 reply');
    await page.keyboard.press('Enter');
    await until(() => state.v1Inputs.some(x => x.text.endsWith('Synthetic V1 reply')), 'V1 reply admitted');
    const v1quoted = state.v1Posts.at(-1);
    assert.equal(v1quoted.text, '[Replying to Orkestr message: "Synthetic coordinator answer"]\n\nSynthetic V1 reply');
    assert.equal(v1quoted.reply_to, undefined, 'V1 receives the line only');
    await page.waitForFunction(() => [...document.querySelectorAll('.v1-thread .chat-messages > li')].some(li =>
      li.querySelector('.reply-quote')?.textContent.includes('Synthetic coordinator answer') && li.querySelector('.rich-text')?.textContent.trim() === 'Synthetic V1 reply'), { timeout: 20000 });
    await screenshot(label, 'v1-reply');
    await noHorizontalScroll();
    // Back to a native conversation.
    await openDrawer(label);
    await choose('Assistant');
    await page.waitForSelector('#composer');
    await screenshot(label, 'chat');
  }],
  ['new-whatsapp-chat', async label => {
    await openDrawer(label);
    await clickText('New WhatsApp chat');
    await page.waitForSelector('#whatsapp-chat-name');
    assert.match(await text('.new-whatsapp-chat'), /your 2 WhatsApp number/);
    await page.type('#whatsapp-chat-name', 'Synthetic WhatsApp chat');
    await page.select('#whatsapp-chat-effort', 'low');
    await page.type('#whatsapp-chat-workspace', '/srv/synthetic');
    await screenshot(label, 'new-whatsapp-chat');
    await clickText('Create WhatsApp chat');
    // The first attempt stops at the adapter; Retry continues the same request.
    await waitText('Retry continues from there');
    await screenshot(label, 'new-whatsapp-chat-stopped');
    await clickText('Retry');
    await page.waitForFunction(() => document.querySelector('.heading-title h2')?.textContent === 'Synthetic WhatsApp chat', { timeout: 20000 });
    assert.equal(state.chatPosts.length, 2);
    assert.equal(state.chatPosts[0].client_request_id, state.chatPosts[1].client_request_id, 'Retry keeps the request id');
    assert.deepEqual({ ...state.chatPosts[0], client_request_id: 'k' }, { client_request_id: 'k', name: 'Synthetic WhatsApp chat',
      provider: 'codex', model: null, reasoning_effort: 'low', workspace: '/srv/synthetic' });
    await page.waitForSelector('#composer');
    await noHorizontalScroll();
  }],
  ['chat-settings', async label => {
    await openDrawer(label);
    await choose('Assistant');
    await page.waitForSelector('#composer');
    await clickText('Settings');
    await page.waitForSelector('#settings-model');
    assert.equal(await page.$eval('#settings-model', n => n.value), 'synthetic-model');
    await page.select('#settings-effort', 'high');
    await page.$eval('#settings-prefix', n => { n.value = ''; });
    await page.type('#settings-prefix', 'synthetic-new:');
    // Auto-accept (V1) is the default; review before accepting is an opt-in.
    await waitText('Review replies before accepting');
    await clickText('Save settings');
    await waitText('Saved (revision 3)');
    assert.deepEqual(state.settingsPuts.at(-1), { expected_revision: 2, provider: 'codex', model: 'synthetic-model', reasoning_effort: 'high',
      honor_no_reply: true, reply_prefix: 'synthetic-new:', reply_footer: null, review_before_accepting: false });
    // Desktops of the chat: binding and current lease.
    await waitText('synthetic-desk');
    assert.equal(await page.$eval('#desktop-thread', n => n.value), 'synthetic-thread');
    await page.type('#desktop-slugs', ', other-desk');
    await clickText('Save desktops');
    await waitText('Desktops saved (revision 2)');
    assert.deepEqual(state.bindingPuts.at(-1).desktop_slugs, ['synthetic-desk', 'other-desk']);
    await screenshot(label, 'chat-settings');
    await noHorizontalScroll();
    // Timers of the chat are listed; selecting one opens its controls.
    await clickText('Timers');
    await waitText('Synthetic morning brief');
    // Calendar timer: rule in plain words, next run, last result, silent-run count.
    await waitText('Hourly at :00, Mon\u2013Fri, 08:00\u201319:00 Europe/Berlin');
    await waitText('Wed 21 Oct 14:00 CEST');
    await waitText('Silent: no news');
    await waitText('4 silent runs since the last message');
    await waitText('Silent unless new');
    await waitText('Recent digests (1)');
    await screenshot(label, 'timers');
    await noHorizontalScroll();
    // Pause the timer for an hour, see it paused, resume it.
    await page.evaluate(() => [...document.querySelectorAll('.timer-card summary')].find(n => n.textContent.startsWith('Pause Synthetic triage')).click());
    await clickWithin('.timer-card', '1 hour');
    await page.waitForFunction(() => document.body.textContent.includes('Paused until Thu 22 Oct 09:00 CEST'));
    const pause = state.timerCalls.find(c => c.route === ':id/pause');
    assert.ok(Number.isSafeInteger(pause.until_ms) && pause.until_ms > Date.now(), 'pause until a future instant');
    assert.deepEqual(Object.keys(pause).sort(), ['method', 'route', 'until_ms'], 'only the end of the pause is sent');
    await clickWithin('.timer-card', 'Resume');
    await page.waitForFunction(() => !document.body.textContent.includes('Paused until'));
    assert.equal(state.timerCalls.filter(c => c.route === ':id/pause').at(-1).until_ms, null);
    // Whole-chat pause and resume.
    await page.evaluate(() => [...document.querySelectorAll('.timer-chatbar summary')][0].click());
    await clickWithin('.timer-chatbar', 'Until I resume');
    await waitText('Timers in this chat are paused');
    await clickText('Resume all');
    await page.waitForFunction(() => !document.body.textContent.includes('Timers in this chat are paused'));
    assert.deepEqual(state.timerCalls.filter(c => c.scope === 'chat').map(c => c.until_ms), [4102444800000, null]);
    // Editor: live plain-words preview, next runs from the server, nothing sent until saved.
    await clickText('New timer');
    await page.waitForSelector('#timer-name');
    await page.type('#timer-name', 'Evening check');
    await page.$eval('#timer-start', n => { n.value = ''; });
    await page.type('#timer-start', '09:00');
    await page.$eval('#timer-end', n => { n.value = ''; });
    await page.type('#timer-end', '20:00');
    await waitText('Hourly at :00, Mon\u2013Fri, 09:00\u201320:00 Europe/Berlin');
    await clickText('Show next runs');
    await waitText('Wed 21 Oct 15:00 CEST');
    await page.type('#timer-text', 'Look for news');
    await screenshot(label, 'timer-editor');
    await noHorizontalScroll();
    await clickText('Create and start');
    await page.waitForFunction(() => document.body.textContent.includes('Saved.'));
    const created = state.timerCalls.find(c => c.route === 'calendar' && c.method === 'POST');
    assert.equal(created.label, 'Evening check');
    assert.equal(created.schedule.start_minute, 540);
    assert.equal(created.schedule.end_minute, 1200);
    assert.equal(created.text, 'Look for news');
    assert.equal(created.policy.silent_mode, 'unless_changed');
    assert.ok(!('next_due_ms' in created) && !('generation' in created), 'no clock or claim from the page');
    await clickText('Chat');
  }],
  ['provider-handoff', label => providerHandoff({ page, state, label, openDrawer, choose, clickText, waitText, screenshot, noHorizontalScroll })],
  ['v1-manage', async label => {
    await openDrawer(label);
    await choose('Synthetic group');
    await page.waitForSelector('.v1-tabs');
    await page.waitForSelector('#v1-composer');
    await clickWithin('.v1-tabs', 'Settings');
    await page.waitForSelector('#v1-model');
    await page.select('#v1-effort', 'high');
    await clickText('Save model and effort');
    await waitText('Saved in V1.');
    assert.deepEqual(state.v1Calls.find(c => c.area === 'settings' && c.method === 'PUT').input, { model: 'synthetic-model', effort: 'high' });
    await page.click('#v1-participants');
    await page.type('#v1-participants', '10000000001@c.us');
    await clickText('Save WhatsApp options');
    await page.waitForFunction(() => document.querySelectorAll('.settings-status').length >= 2);
    assert.deepEqual(state.v1Calls.find(c => c.area === 'whatsapp' && c.method === 'PUT').input.additional_participant_ids, ['10000000001@c.us']);
    await waitText('synthetic-desk');
    await screenshot(label, 'v1-settings');
    await noHorizontalScroll();
    await page.evaluate(() => [...document.querySelectorAll('.v1-tabs button')].find(b => b.textContent === 'Timers').click());
    await waitText('Synthetic digest');
    await clickText('Pause');
    await page.waitForFunction(() => [...document.querySelectorAll('.v1-timer .source-badge')].some(b => b.textContent === 'paused'));
    await clickText('New timer');
    await page.type('#v1-timer-label', 'Synthetic evening');
    await page.$eval('#v1-timer-time', n => { n.value = ''; });
    await page.type('#v1-timer-time', '19:30');
    await page.type('#v1-timer-prompt', 'Synthetic evening prompt');
    await clickText('Save timer');
    await waitText('Synthetic evening');
    const created = state.v1Calls.find(c => c.area === 'timers' && c.method === 'POST' && !c.timer).input;
    assert.equal(created.time, '19:30'); assert.equal(created.cadence, 'daily'); assert.ok(created.client_request_id);
    await screenshot(label, 'v1-timers');
    await noHorizontalScroll();
    await page.evaluate(() => [...document.querySelectorAll('.v1-tabs button')].find(b => b.textContent === 'Chat').click());
    await page.waitForSelector('#v1-composer');
  }],
  ['host-metrics', async label => {
    // The heading panel is always visible and opens the host overview.
    await page.waitForFunction(() => document.querySelector('.host-metrics-panel')?.textContent.includes('32%'), { timeout: 20000 });
    await page.click('.host-metrics-panel');
    await page.waitForFunction(() => location.hash === '#host');
    await waitText('Top consumers');
    await page.waitForFunction(() => document.querySelectorAll('.hd-gauge').length >= 5 && document.querySelectorAll('.thread-bars li').length === 12);
    await waitText('Synthetic V1 UI');
    await waitText('/home');
    await waitText('Synthetic probe');
    assert.equal(await page.$eval('.consumer-row .who a', a => a.getAttribute('href')), '#conversation/00000000-0000-4000-8000-00000000000a');
    await screenshot(label, 'host-overview');
    await noHorizontalScroll();
    // Charts are a deep link of their own, range included; back returns.
    await clickText('Charts');
    await page.waitForFunction(() => document.querySelectorAll('.metric-chart').length >= 9, { timeout: 20000 });
    await clickText('7d');
    await page.waitForFunction(() => location.hash === '#host/details?range=7d');
    await waitText('Collecting… history for this range starts');
    await screenshot(label, 'host-metrics');
    await noHorizontalScroll();
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#host/details?range=1h');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => location.hash === '#host/details?range=1h' && document.querySelectorAll('.metric-chart').length >= 9, { timeout: 30000 });
    await page.goto(`${origin}/#conversation/00000000-0000-4000-8000-00000000000a/timers`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitText('Saved timer ID', 30000);
    await clickText('Chat');
    await page.waitForFunction(() => location.hash === '#conversation/00000000-0000-4000-8000-00000000000a');
    await page.goBack();
    await page.waitForFunction(() => location.hash.endsWith('/timers'));
    await waitText('Saved timer ID');
    await clickText('Chat');
    await page.waitForSelector('#composer');
  }],
  ['v1-deep-links', async label => {
    const open = ref => page.goto(`${origin}/instance/${V1_INSTANCE_REF}/thread/${ref}`, { waitUntil: 'domcontentloaded' });
    // A thread still on V1 opens its linked entry.
    await open(V1_LINKS.group);
    await page.waitForSelector('.v1-banner', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.heading-title h2')?.textContent === 'Synthetic group');
    // The old V1 fragment gives way to the chat's own deep link.
    await page.waitForFunction(() => /^#v1\/[A-Za-z0-9._:-]+$/.test(location.hash));
    await screenshot(label, 'v1-link-v1');
    // A migrated thread opens its V2 conversation.
    await open(V1_LINKS.migrated);
    await page.waitForFunction(() => document.querySelector('.heading-title h2')?.textContent === 'Research notes', { timeout: 20000 });
    await page.waitForSelector('#composer');
    assert.equal(await page.$('.v1-banner'), null);
    // An unknown link explains itself and keeps the default conversation.
    await open(V1_LINKS.unknown);
    await waitText('This V1 link does not open here');
    await screenshot(label, 'v1-link-unknown');
    await noHorizontalScroll();
  }],
  ['message-formatting', async label => {
    // Agent Markdown, WhatsApp emphasis and the reply context render as
    // elements; markup in message text stays text.
    await page.goto(`${origin}/#v1/${V1_WORKER}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.v1-thread .chat-messages > li').length === 3, { timeout: 20000 });
    const view = await page.evaluate(() => {
      const scope = document.querySelector('.v1-thread .chat-messages');
      const texts = sel => [...scope.querySelectorAll(sel)].map(n => n.textContent);
      return { strong: texts('.rich-text strong'), em: texts('.rich-text em'), strike: texts('.rich-text s'), heading: texts('.rich-text h4'),
        code: texts('.rich-text pre.rt-code'), bullets: scope.querySelectorAll('.rt-list li').length, cells: texts('.rt-table td'),
        reply: texts('.rt-reply'), links: [...scope.querySelectorAll('.rich-text a')].map(a => [a.getAttribute('href'), a.rel]),
        html: scope.querySelectorAll('b').length, raw: /\*\*|~~|```|\|---/.test(scope.textContent) };
    });
    assert.deepEqual(view.heading, ['Synthetic status']);
    for (const word of ['Synthetic WhatsApp summary', 'Bold item', 'build', 'green']) assert.ok(view.strong.includes(word), word);
    assert.deepEqual(view.em, ['italic']); assert.deepEqual(view.strike, ['strike', 'red']);
    assert.match(view.code[0], /^cargo test --offline/);
    assert.equal(view.bullets, 6); assert.ok(view.cells.includes('rust-v2'));
    assert.match(view.reply[0], /^Replying to Orkestr message from 15:23/);
    assert.deepEqual(view.links[0], ['https://example.invalid/runbook', 'noopener noreferrer nofollow']);
    assert.equal(view.html, 0, 'message markup is never parsed as HTML');
    assert.equal(view.raw, false, 'no literal Markdown markers remain');
    await screenshot(label, 'message-formatting');
    await noHorizontalScroll();
  }],
  ['chat-first-details-drawer', async label => {
    await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer');
    await page.evaluate(() => { try { localStorage.removeItem('orkestr.v2.conversationDetailsOpen'); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.details-toggle');
    // Technical panels start hidden and never sit inside the transcript.
    const drawer = () => page.evaluate(() => {
      const aside = document.querySelector('.conversation-details');
      return { shown: !!aside && getComputedStyle(aside).display !== 'none', expanded: document.querySelector('.details-toggle').getAttribute('aria-expanded'),
        inTranscript: !!document.querySelector('.conversation-scroll .conversation-tools'),
        stored: (() => { try { return localStorage.getItem('orkestr.v2.conversationDetailsOpen'); } catch { return 'unavailable'; } })() };
    });
    assert.deepEqual(await drawer(), { shown: false, expanded: 'false', inTranscript: false, stored: null });
    assert.ok(!(await page.evaluate(() => document.querySelector('.conversation-pane').innerText)).includes('Thread files'), 'Thread files are hidden in the chat');
    assert.ok(!(await page.evaluate(() => document.body.textContent)).includes('Result accepted'), 'no acceptance jargon');
    await screenshot(label, 'chat-details-closed');
    // Details opens a drawer and remembers it for this viewer.
    await page.click('.details-toggle');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.conversation-details')).display !== 'none');
    assert.deepEqual(await drawer(), { shown: true, expanded: 'true', inTranscript: false, stored: '1' });
    await waitText('Thread files');
    await screenshot(label, 'chat-details-open');
    await noHorizontalScroll();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.details-toggle')?.getAttribute('aria-expanded') === 'true', { timeout: 15000 });
    await page.click('.details-toggle');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.conversation-details')).display === 'none');
    assert.equal((await drawer()).stored, '0');
  }],
  ['every-answer-inline', async label => {
    // 25 accepted answers span two pages; all show inline, newest included,
    // as plain messages without paging or acceptance wording.
    await page.goto(`${origin}/#conversation/${C}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-messages .assistant-message')].some(li => li.textContent.includes('Synthetic answer 25')), { timeout: 20000 });
    const view = await page.evaluate(() => ({
      answers: [...document.querySelectorAll('.chat-messages .assistant-message .accepted-output')].map(n => n.textContent.trim()),
      text: document.querySelector('.conversation-pane').innerText }));
    assert.equal(view.answers.length, 25, 'every accepted answer is inline');
    assert.equal(view.answers[0], 'Synthetic answer 1');
    assert.equal(view.answers.at(-1), 'Synthetic answer 25', 'in order, newest last');
    for (const jargon of ['Reply history pages', 'Accepted reply', 'Reply details', 'Provider output', 'review before accepting', 'Result accepted'])
      assert.ok(!view.text.includes(jargon), `no "${jargon}" in the chat`);
    await page.waitForFunction(() => {
      const el = document.querySelector('.conversation-pane > .conversation-scroll');
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 72;
    });
    await screenshot(label, 'every-answer-inline');
    await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }],
  ['live-catch-up', async label => {
    await page.waitForSelector('#composer');
    await page.waitForFunction(() => document.querySelectorAll('.chat-messages .user-message').length > 0);
    // The synthetic stream only sends keep-alives. A message written while it
    // is quiet still shows once the stream is woken (Retry, focus, tab shown).
    const text = `Written while the stream was quiet (${label})`;
    state.messages[A].push({ message_id: `00000000-0000-4000-8000-0000000009${label === 'phone' ? '02' : '01'}`, sequence: state.messages[A].length + 1, actor_kind: 'owner', text });
    await page.evaluate(() => window.dispatchEvent(new Event('orkestr-stream-retry')));
    await page.waitForFunction(t => [...document.querySelectorAll('.chat-messages .user-message')].some(li => li.textContent.includes(t)), { timeout: 8000 }, text);
    // The newest message is in view.
    await page.waitForFunction(() => {
      const el = document.querySelector('.conversation-pane > .conversation-scroll');
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 72;
    });
    assert.equal(await page.$('.connection-bar'), null, 'no reconnect bar while connected');
  }],
];

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
    Object.assign(state, createState());
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport(viewport);
    stage = `${label}:load`;
    await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer');
    for (const [name, run] of scenarios) {
      stage = `${label}:${name}`;
      await run(label);
    }
    stage = `${label}:layout`;
    await noHorizontalScroll();
    stage = `${label}:dark`;
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await new Promise(resolve => setTimeout(resolve, 400)); // let color transitions settle
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = background.match(/\d+/g).map(Number);
    assert.ok(r + g + b < 120, `Dark mode background expected, got ${background}`);
    await screenshot(label, 'chat-dark');
    if (label === 'phone') await openDrawer(label);
    await screenshot(label, 'sidebar-dark');
    await page.emulateMediaFeatures([]);
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser rendering errors');
  console.log(`PASS: configured workspace rendering (${scenarios.map(s => s[0]).join(', ')}) at desktop and phone widths; synthetic API only, no provider qualification`);
} catch (error) {
  const view = await page?.evaluate(() => ({ hash: location.hash, heading: document.querySelector('.heading-title')?.textContent,
    tabs: [...document.querySelectorAll('.v1-tabs button')].map(n => ({ text: n.textContent, current: n.getAttribute('aria-current') })),
    body: document.body.innerText.slice(-4500) })).catch(() => null);
  await screenshot('failure', stage.replace(/[^a-z0-9-]/gi, '-')).catch(() => {});
  console.error(JSON.stringify({ stage, error: error.message, requests: state.requests.slice(-25), pageErrors: errors, view }));
  throw error;
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections?.();
}
