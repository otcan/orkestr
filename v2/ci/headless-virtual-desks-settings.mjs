// Real WASM view acceptance, called by the existing isolated workspace harness.
import assert from 'node:assert/strict';

export async function virtualDesksAndAccountSettings({page, state, conversation, clickText, clickWithin, waitText, screenshot, label}) {
    const before = {bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length};
    const badge = '.app-heading .build-badge';
    await page.waitForSelector(`${badge} button`);
    const heading = await page.$eval(`${badge} button`, el => ({text:el.textContent.trim(), title:el.title}));
    assert.match(heading.text, /^v\d+\./, 'heading must show the actual web package version');
    assert.match(heading.title, /Web version: .*\nWeb source: .*\nClick for web and server build details\./);
    await page.hover(`${badge} button`);
    assert.equal(await page.$eval(`${badge} button`, el => el.getAttribute('aria-expanded')), 'false', 'hover retains native tooltip without opening the panel');
    assert.equal(await page.$(`${badge} .build-badge-details`), null, 'closed build details must not mount About or its request');
    await page.click(`${badge} button`);
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true', {}, `${badge} button`);
    await waitText('Server version: 9.8.7-test');
    assert.ok((await page.$eval(`${badge} .build-badge-details`, el => el.textContent)).includes('f'.repeat(40)),
        'click details must show the separately observed full backend source');
    await screenshot(label, 'build-version-details');
    await page.click(`${badge} button`);
    assert.equal(await page.$(`${badge} .build-badge-details`), null);
    assert.equal(await page.$('.owner-password'), null, 'password form must not appear under the chat');
    await clickText('Virtual desks');
    await waitText('All desk resources.');
    await waitText('Research desk');
    await waitText('Unbound desk');
    await waitText('Availability not verified');
    await waitText('1 available to reserve');
    await waitText('2 need checking');
    assert.ok((await page.$eval('[aria-label="Desk research-desk"]', el => el.textContent)).includes('does not mean the desk is free'));
    assert.equal(await page.$('[aria-label="Desk unbound-desk"] button'),null,'unbound inventory must not offer scoped actions');
    assert.equal(new URL(page.url()).pathname, '/virtual-desks');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(state.desktopActions.length,0,'inventory must have no effects');
    await page.type('[aria-label="Virtual desks"] input[type="search"]','research');
    await page.waitForFunction(()=>document.querySelectorAll('.desk-card:not([hidden])').length===1);
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"]',el=>el.hidden),true);
    await page.$eval('[aria-label="Virtual desks"] input[type="search"]',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelectorAll('.desk-card:not([hidden])').length===3);
    assert.equal(state.desktopActions.length,0,'search has no desk effects');
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"] select',el=>el.value),conversation,'sole connected chat is selected without creating any effects');
    assert.equal(await page.$('.owner-password'), null, 'password form belongs only in Settings');
    await clickWithin('[aria-label="Desk synthetic-desk"]', 'Get viewing link');
    await page.waitForSelector('[aria-label="Virtual desks"] a[target="_blank"]');
    assert.deepEqual(await page.$eval('[aria-label="Virtual desks"] a', a => ({href:a.href,rel:a.rel})), {
        href:'https://desktop.example.test/desktop-share/synthetic?key=fixture', rel:'noopener noreferrer',
    });
    assert.deepEqual({bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length}, before,
        'viewing and preparing a link must not change grants/settings or start work');
    await screenshot(label, 'virtual-desks');
    const viewport=page.viewport();
    await page.setViewport({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'desk inventory fits narrow screens');
    await screenshot(label,'virtual-desks-mobile');
    await page.setViewport(viewport);
    await clickWithin('[aria-label="Desk synthetic-desk"]','Reserve for 10 minutes');
    await waitText('Reserved for 10 minutes.');
    await page.type('[aria-label="Virtual desks"] input[type="search"]','research');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Desk synthetic-desk"]').hidden);
    await page.$eval('[aria-label="Virtual desks"] input[type="search"]',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>!document.querySelector('[aria-label="Desk synthetic-desk"]').hidden);
    assert.ok((await page.$eval('[aria-label="Desk synthetic-desk"]',el=>el.textContent)).includes('Release reservation'),'search must retain the current fencing token and release action');
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"] details',el=>el.open),false,'restart stays secondary and collapsed');
    await clickWithin('[aria-label="Desk synthetic-desk"]','Advanced: restart desk');
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
