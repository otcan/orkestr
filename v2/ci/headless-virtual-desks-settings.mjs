// Real WASM view acceptance, called by the existing isolated workspace harness.
import assert from 'node:assert/strict';

export async function virtualDesksAndAccountSettings({page, state, conversation, clickText, clickWithin, waitText, screenshot, label}) {
    const before = {bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length};
    assert.equal(await page.$('.owner-password'), null, 'password form must not appear under the chat');
    await clickText('Virtual desks');
    await waitText('All desk resources.');
    await waitText('Research desk');
    await waitText('Unbound desk');
    await waitText('Reservation: unknown');
    assert.equal(new URL(page.url()).pathname, '/virtual-desks');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(state.desktopActions.length,0,'inventory must have no effects');
    await page.select('[aria-label="Desk synthetic-desk"] select',conversation);
    assert.equal(await page.$('.owner-password'), null, 'password form belongs only in Settings');
    await clickWithin('[aria-label="Virtual desks"]', 'Open desktop');
    await page.waitForSelector('[aria-label="Virtual desks"] a[target="_blank"]');
    assert.deepEqual(await page.$eval('[aria-label="Virtual desks"] a', a => ({href:a.href,rel:a.rel})), {
        href:'https://desktop.example.test/desktop-share/synthetic?key=fixture', rel:'noopener noreferrer',
    });
    assert.deepEqual({bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length}, before,
        'viewing and preparing a link must not change grants/settings or start work');
    await screenshot(label, 'virtual-desks');
    await clickWithin('[aria-label="Desk synthetic-desk"]','Reserve for 10 minutes');
    await waitText('Reserved for 10 minutes.');
    await clickWithin('[aria-label="Desk synthetic-desk"]','Reset runtime…');
    assert.equal(state.desktopActions.filter(a=>a.action==='reset').length,0,'confirmation must precede reset');
    await clickWithin('[aria-label="Desk synthetic-desk"]','Confirm reset');
    await waitText('Desk runtime reset.');
    await clickWithin('[aria-label="Desk synthetic-desk"]','Release reservation');
    await waitText('Reservation released.');
    assert.deepEqual(state.desktopActions.map(a=>a.action),['acquire','reset','release']);
    await page.reload({waitUntil:'networkidle0'});
    await waitText('All desk resources.');
    assert.equal(new URL(page.url()).pathname,'/virtual-desks','clean URL must survive direct refresh');
    assert.equal(state.desktopActions.length,3,'refresh must not repeat effects');
    await clickText('Settings');
    await page.waitForSelector('#settings-model');
    await page.waitForSelector('[aria-label="Account settings"] .owner-password');
    assert.equal(new URL(page.url()).hash, `#conversation/${conversation}/settings`);
    assert.equal(await page.$$eval('.owner-password', nodes => nodes.length), 1);
    assert.equal(await page.$eval('.owner-password summary', n => n.textContent.trim()), 'Change password');
}
