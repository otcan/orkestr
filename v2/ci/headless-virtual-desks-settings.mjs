// Real WASM view acceptance, called by the existing isolated workspace harness.
import assert from 'node:assert/strict';

export async function virtualDesksAndAccountSettings({page, state, conversation, clickText, clickWithin, waitText, screenshot, label}) {
    const before = {bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length};
    assert.equal(await page.$('.owner-password'), null, 'password form must not appear under the chat');
    await clickText('Virtual desks');
    await waitText('Desktops connected to this chat.');
    await waitText('Recorded lease: active');
    assert.equal(new URL(page.url()).hash, `#conversation/${conversation}/virtual-desks`);
    assert.equal(await page.$('.owner-password'), null, 'password form belongs only in Settings');
    await waitText('Agent access has not been issued for this chat.');
    await clickWithin('[aria-label="Virtual desks"]', 'Open desktop');
    await page.waitForSelector('[aria-label="Virtual desks"] a[target="_blank"]');
    assert.deepEqual(await page.$eval('[aria-label="Virtual desks"] a', a => ({href:a.href,rel:a.rel})), {
        href:'https://desktop.example.test/desktop-share/synthetic?key=fixture', rel:'noopener noreferrer',
    });
    assert.deepEqual({bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length}, before,
        'viewing and preparing a link must not change grants/settings or start work');
    await screenshot(label, 'virtual-desks');
    await clickText('Configure desks');
    await page.waitForSelector('#settings-model');
    await page.waitForSelector('[aria-label="Account settings"] .owner-password');
    assert.equal(new URL(page.url()).hash, `#conversation/${conversation}/settings`);
    assert.equal(await page.$$eval('.owner-password', nodes => nodes.length), 1);
    assert.equal(await page.$eval('.owner-password summary', n => n.textContent.trim()), 'Change password');
}
