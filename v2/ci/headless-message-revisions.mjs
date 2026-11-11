// The owner edits and deletes their own message; other rows offer neither.
import assert from 'node:assert/strict';

const OWN = '00000000-0000-4000-8000-000000009101';
const OTHER = '00000000-0000-4000-8000-000000009102';
const REFUSED = '00000000-0000-4000-8000-000000009103';

const row = (page, id) => page.evaluate(id => {
  const article = document.querySelector(`article[data-message-id="${id}"]`);
  return article ? {
    text: article.querySelector('.rich-text')?.textContent.trim() ?? '',
    buttons: [...article.querySelectorAll('button')].map(b => b.textContent.trim()),
    edited: article.querySelector('.message-edited')?.textContent.trim() ?? '',
    removed: Boolean(article.querySelector('.message-removed')),
  } : null;
}, id);

// ORK-786: Edit, Delete and History are items of the message's actions menu;
// the edit form and the delete confirmation then show on the message.
const menu = async (page, id) => {
  const toggle = `article[data-message-id="${id}"] .message-menu-toggle`;
  if (!(await page.$(`article[data-message-id="${id}"] .message-menu-list`))) await page.$eval(toggle, b => b.click());
  await page.waitForSelector(`article[data-message-id="${id}"] .message-menu-list`);
  return page.$$eval(`article[data-message-id="${id}"] .message-menu-item`, items => items.map(b => b.textContent.trim()));
};
const closeMenu = async (page, id) => {
  if (await page.$(`article[data-message-id="${id}"] .message-menu-list`)) await page.$eval(`article[data-message-id="${id}"] .message-menu-toggle`, b => b.click());
  await page.waitForFunction(id => !document.querySelector(`article[data-message-id="${id}"] .message-menu-list`), {}, id);
};
const press = async (page, id, label) => {
  const visible = () => page.evaluate((id, label) => {
    const button = [...document.querySelectorAll(`article[data-message-id="${id}"] button`)]
      .find(b => b.textContent.trim() === label && !b.disabled && !b.hidden);
    if (!button) return false;
    button.click(); return true;
  }, id, label);
  if (await visible()) return;
  if (['Edit', 'Delete', 'History', 'Hide history', 'Reply', 'Copy text'].includes(label)) await menu(page, id);
  assert.ok(await visible(), `Missing button on the message: ${label}`);
};

const revise = async (page, id, text) => {
  await press(page, id, 'Edit');
  const box = `article[data-message-id="${id}"] .message-edit textarea`;
  await page.waitForSelector(box);
  await page.$eval(box, node => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type(box, text);
  await page.waitForFunction(selector => {
    const form = document.querySelector(selector)?.closest('form');
    return form && !form.querySelector('button[type=submit]').disabled;
  }, {}, box);
  await press(page, id, 'Save');
};

export async function messageRevisions({ page, state, origin, conversation, returnConversation, screenshot, label }) {
  const messages = state.messages[conversation];
  state.revisionPosts = [];
  state.revisionHistory = {};
  state.messages[conversation] = [
    { message_id: OWN, sequence: 1, actor_kind: 'owner', text: 'Synthetic text with a typo', revisions: { can_revise: true } },
    { message_id: OTHER, sequence: 2, actor_kind: 'owner', text: 'Synthetic member message' },
    { message_id: REFUSED, sequence: 3, actor_kind: 'owner', text: 'Synthetic refused message', revisions: { can_revise: true } },
  ];
  const open = async () => {
    await page.goto(`${origin}/#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`article[data-message-id="${OWN}"]`, { timeout: 20000 });
  };
  try {
    await open();
    const first = await row(page, OWN);
    assert.equal(first.buttons.includes('Edit') || first.buttons.includes('Delete'), false, 'no inline edit or delete controls');
    assert.deepEqual(await menu(page, OWN), ['Reply', 'Copy text', 'Edit', 'Delete'], 'own message menu offers edit and delete');
    // Keyboard: focus moves into the menu; Escape closes it and returns focus.
    const focusIn = (id, selector) => page.waitForFunction((id, selector) => document.activeElement?.matches(selector)
      && document.activeElement.closest('article')?.dataset.messageId === id, {}, id, selector);
    await focusIn(OWN, '.message-menu-list .message-menu-item');
    await page.keyboard.press('Escape');
    await page.waitForFunction(id => !document.querySelector(`article[data-message-id="${id}"] .message-menu-list`), {}, OWN);
    await focusIn(OWN, '.message-menu-toggle');
    assert.deepEqual(await menu(page, OTHER), ['Reply', 'Copy text'], 'a member message offers neither edit nor delete');
    await screenshot(label, 'message-menu');
    await closeMenu(page, OTHER);

    await revise(page, OWN, 'Synthetic text, corrected');
    for (let i = 0; i < 100 && state.revisionPosts.length < 1; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(state.revisionPosts.length, 1, 'one edit was posted');
    const posted = state.revisionPosts[0];
    assert.equal(posted.target, OWN);
    assert.equal(posted.kind, 'edit');
    assert.equal(posted.text, 'Synthetic text, corrected');
    assert.equal(posted.expected_revision, 0);
    assert.match(posted.request_key, /^[0-9a-f-]{36}$/);

    await open();
    await page.waitForFunction(id => document.querySelector(`article[data-message-id="${id}"] .rich-text`)?.textContent.includes('corrected'), { timeout: 20000 }, OWN);
    const edited = await row(page, OWN);
    assert.equal(edited.text, 'Synthetic text, corrected');
    assert.equal(edited.edited, 'Edited');
    await page.waitForFunction(() => document.querySelector('.revision-notice')?.textContent.includes('You edited a message'));
    await press(page, OWN, 'History');
    await page.waitForFunction(id => document.querySelector(`article[data-message-id="${id}"] .message-history`)?.textContent.includes('Synthetic text with a typo'), { timeout: 20000 }, OWN);
    await screenshot(label, 'message-edited');

    await press(page, OWN, 'Delete');
    await page.waitForFunction(id => [...document.querySelectorAll(`article[data-message-id="${id}"] button`)].some(b => b.textContent.trim() === 'Confirm delete'), {}, OWN);
    await press(page, OWN, 'Confirm delete');
    for (let i = 0; i < 100 && state.revisionPosts.length < 2; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(state.revisionPosts[1].kind, 'delete');
    assert.equal('text' in state.revisionPosts[1], false);
    assert.equal(state.revisionPosts[1].expected_revision, 1);

    await open();
    await page.waitForFunction(id => document.querySelector(`article[data-message-id="${id}"] .message-removed`), { timeout: 20000 }, OWN);
    const removed = await row(page, OWN);
    assert.equal(removed.removed, true);
    assert.equal(removed.text, '', 'the removed text is not shown');
    assert.equal(removed.buttons.includes('Edit'), false);
    assert.equal(removed.buttons.includes('Reply'), false);
    assert.deepEqual(await menu(page, OWN), ['History'], 'a removed message only offers its history');
    await closeMenu(page, OWN);
    await screenshot(label, 'message-deleted');

    // The server decides. A refusal is shown, and nothing pretends it worked.
    state.revisionRefuse = true;
    await revise(page, REFUSED, 'Synthetic attempt');
    await page.waitForFunction(id => document.querySelector(`article[data-message-id="${id}"] .message-action-error`)?.textContent.includes('Only your own messages'), { timeout: 20000 }, REFUSED);
    const refused = await row(page, REFUSED);
    assert.equal(refused.text, 'Synthetic refused message');
    assert.equal(refused.edited, '');
  } finally {
    state.revisionRefuse = false;
    state.messages[conversation] = messages;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
