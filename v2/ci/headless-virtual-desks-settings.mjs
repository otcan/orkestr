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
    await page.waitForFunction(selector => !document.querySelector(selector), {}, `${badge} .build-badge-details`);
    assert.equal(await page.$('.owner-password'), null, 'password form must not appear under the chat');
    await clickText('Virtual desks');
    await waitText('All desk resources.');
    await waitText('Research desk');
    await waitText('Unbound desk');
    await waitText('Availability not verified');
    await waitText('2 available to reserve');
    await waitText('1 reserved');
    await waitText('2 need checking');
    const row = slug => `[aria-label="Desk ${slug}"]`;
    const rowText = slug => page.$eval(row(slug), el => el.textContent);
    const rowHas = (slug, snippet) => page.waitForFunction((selector, s) => document.querySelector(selector)?.textContent.includes(s), {timeout:15000}, row(slug), snippet);
    const rowLacks = (slug, snippet) => page.waitForFunction((selector, s) => !document.querySelector(selector)?.textContent.includes(s), {timeout:15000}, row(slug), snippet);
    const cell = (slug, column) => page.$eval(`${row(slug)} .desk-main > [data-label="${column}"]`, el => el.textContent.trim());
    const runtimeIs = (slug, value) => page.waitForFunction((selector, v) => document.querySelector(selector)?.textContent.trim() === v, {timeout:15000}, `${row(slug)} .desk-runtime`, value);
    const buttons = slug => page.$$eval(`${row(slug)} .desk-owner-buttons button`, nodes => nodes.map(n => n.textContent.trim()));
    const confirmation = slug => `${row(slug)} .desk-confirm`;
    const detailShown = slug => page.$eval(`${row(slug)} .desk-detail`, el => !el.hidden);
    const inventoryReads = () => state.requests.filter(r => r === 'GET /api/v2/desktops').length;
    const slugs = ['synthetic-desk', 'research-desk', 'unbound-desk', 'idle-desk', 'held-desk'];
    // Wait until the table has been re-read from the server and rendered.
    const reread = async before => {
        for (const end = Date.now() + 15000; inventoryReads() <= before;) {
            assert.ok(Date.now() < end, 'the table is re-read after an action');
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Virtual desks"] button')]
            .some(b => b.textContent.trim() === 'Refresh' && !b.disabled));
    };

    // A real table: column headers with scope, one row group per desk.
    assert.equal(await page.$('.desk-grid, .desk-card, .desk-list'), null, 'the grid and list layouts are gone');
    assert.equal(await page.$eval('.desk-table', el => el.tagName), 'TABLE');
    assert.deepEqual(await page.$$eval('.desk-table thead th', nodes => nodes.map(n => [n.textContent.trim(), n.getAttribute('scope')])),
        [['Desk','col'],['Reservation','col'],['Runtime','col'],['Held by','col'],['Actions','col']]);
    assert.deepEqual(await page.$$eval('.desk-table > tbody.desk-row .desk-main > th[scope="row"] .desk-label', nodes => nodes.map(n => n.textContent)),
        ['Synthetic desk', 'Research desk', 'Unbound desk', 'Idle desk', 'Held desk'], 'one row per desk');
    assert.deepEqual(await page.$$eval(`${row('held-desk')} .desk-main > *`, cells => cells.map(c => c.dataset.label)),
        ['Desk', 'Reservation', 'Runtime', 'Held by', 'Actions']);
    assert.match(await cell('held-desk', 'Held by'), /^Worker chat\s*until 2026-01-01T02:00:00Z$/);
    assert.equal(await cell('idle-desk', 'Held by'), '—');
    assert.equal(await cell('unbound-desk', 'Held by'), 'Not verified', 'unknown is never shown as held by nobody');
    assert.equal(await cell('research-desk', 'Runtime'), 'stopped');
    // Explanations are a legend and a tooltip, not text inside the rows.
    assert.match(await page.$eval('.desk-legend', el => el.textContent), /does not mean the desk is free/);
    const unknownBadge = await page.$eval(`${row('research-desk')} .desk-badge`, el => ({token:el.dataset.availability, text:el.textContent, title:el.title}));
    assert.deepEqual({token:unknownBadge.token, text:unknownBadge.text}, {token:'unknown', text:'Availability not verified'});
    assert.match(unknownBadge.title, /does not mean the desk is free/);
    assert.ok(!(await rowText('research-desk')).includes('does not mean the desk is free'), 'no long explanation inside the row');
    for (const slug of slugs) assert.equal(await detailShown(slug), false, `${slug} has no detail row until something applies`);
    assert.ok(!(await page.$eval('.desk-table', el => el.textContent)).includes('Treat it like a password'), 'the link warning appears only with a link');
    if (label === 'desktop') {
        assert.equal(await page.$eval('.desk-main > td', el => getComputedStyle(el).display), 'table-cell');
        const heights = await page.$$eval('.desk-main', rows => rows.map(r => Math.round(r.getBoundingClientRect().height)));
        assert.ok(heights.every(h => h <= 72), `rows stay compact (${heights.join(', ')}px)`);
    }
    assert.equal(await page.$eval(`${row('unbound-desk')} [data-availability]`, el => el.dataset.availability), 'unknown', 'unknown never takes the available style');
    assert.equal(await page.$eval(`${row('idle-desk')} [data-availability]`, el => el.dataset.availability), 'available');
    assert.deepEqual(await buttons('idle-desk'), ['Start'], 'a stopped desk can only be started');
    assert.deepEqual(await buttons('research-desk'), ['Start']);
    assert.deepEqual(await buttons('held-desk'), ['Stop', 'Link'], 'a running desk can be stopped or linked');
    assert.deepEqual(await buttons('unbound-desk'), ['Stop'], 'an unverified runtime is neither startable nor shareable');
    assert.equal(await page.$(`${row('unbound-desk')} select`), null, 'an unconnected desk has no chat controls');
    assert.equal(await page.$(`${row('unbound-desk')} .desk-chat-toggle`), null, 'an unconnected desk offers no chat reservation');
    assert.equal(new URL(page.url()).pathname, '/virtual-desks');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(state.desktopActions.length,0,'inventory must have no effects');
    assert.equal(state.deskOwnerActions.length,0,'rendering the table must not act on a desk');
    await page.type('[aria-label="Virtual desks"] input[type="search"]','research');
    await page.waitForFunction(()=>document.querySelectorAll('.desk-row:not([hidden])').length===1);
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"]',el=>el.hidden),true);
    await page.$eval('[aria-label="Virtual desks"] input[type="search"]',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelectorAll('.desk-row:not([hidden])').length===5);
    assert.equal(state.desktopActions.length,0,'search has no desk effects');
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"] select',el=>el.value),conversation,'sole connected chat is selected without creating any effects');
    assert.equal(await page.$('.owner-password'), null, 'password form belongs only in Settings');
    const chatToggle = `${row('synthetic-desk')} .desk-chat-toggle`;
    const chatPanel = `${row('synthetic-desk')} .desk-chat`;
    assert.equal(await page.$eval(chatToggle, el => el.getAttribute('aria-expanded')), 'false');
    assert.equal(await page.$eval(chatPanel, el => el.hidden), true, 'chat reservation stays secondary in the table');
    await page.click(chatToggle);
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true', {}, chatToggle);
    assert.equal(await page.$eval(chatPanel, el => el.hidden), false);
    assert.equal(await detailShown('synthetic-desk'), true, 'the chat controls open under their row');
    await clickWithin('[aria-label="Desk synthetic-desk"]', 'Get viewing link');
    await page.waitForSelector('[aria-label="Virtual desks"] a[target="_blank"]');
    assert.deepEqual(await page.$eval('[aria-label="Virtual desks"] a', a => ({href:a.href,rel:a.rel})), {
        href:'https://desktop.example.test/desktop-share/synthetic?key=fixture', rel:'noopener noreferrer',
    });
    assert.deepEqual({bindings:state.bindingPuts.length, settings:state.settingsPuts.length, windows:state.windowPosts.length}, before,
        'viewing and preparing a link must not change grants/settings or start work');

    // Owner actions on desks that no chat is connected to. After each one the
    // Runtime cell shows the new state, also once the table has been re-read.
    let reads = inventoryReads();
    await clickWithin(row('idle-desk'), 'Start');
    await rowHas('idle-desk', 'Desk started.');
    await runtimeIs('idle-desk', 'active');
    assert.deepEqual(state.deskOwnerActions.at(-1), {action:'start',slug:'idle-desk'});
    await reread(reads);
    await runtimeIs('idle-desk', 'active');
    assert.deepEqual(await buttons('idle-desk'), ['Stop', 'Link'], 'the row follows the new runtime');
    await clickWithin(row('idle-desk'), 'Dismiss');
    await page.waitForFunction(selector => document.querySelector(selector)?.hidden === true, {}, `${row('idle-desk')} .desk-detail`);
    await clickWithin(row('idle-desk'), 'Stop');
    await rowHas('idle-desk', 'Desk stopped.');
    await runtimeIs('idle-desk', 'inactive');
    assert.equal(await page.$(confirmation('idle-desk')), null, 'a free desk stops without a prompt');
    assert.deepEqual(state.deskOwnerActions.at(-1), {action:'stop',slug:'idle-desk',expected_lease_state:'unreserved',expected_holder:null,confirm_interruption:false});

    // A desk a chat has reserved is never stopped without naming that chat.
    const beforeStop = state.deskOwnerActions.length;
    await clickWithin(row('held-desk'), 'Stop');
    await page.waitForSelector(confirmation('held-desk'));
    assert.equal(await detailShown('held-desk'), true, 'the confirmation appears under its row');
    assert.match(await page.$eval(confirmation('held-desk'), el => el.textContent), /Worker chat has Held desk reserved until 2026-01-01T02:00:00Z.*interrupts/s);
    assert.equal(await page.$eval(confirmation('held-desk'), el => el.getAttribute('role')), 'alert', 'the warning is announced');
    assert.equal(state.deskOwnerActions.length, beforeStop, 'nothing happens before confirmation');
    await clickWithin(row('held-desk'), 'Keep it running');
    await page.waitForFunction(selector => !document.querySelector(selector), {}, confirmation('held-desk'));
    assert.equal(state.deskOwnerActions.length, beforeStop, 'cancelling does nothing');
    assert.equal(await detailShown('held-desk'), false, 'cancelling leaves no notice behind');
    await clickWithin(row('held-desk'), 'Stop');
    await page.waitForSelector(confirmation('held-desk'));
    await page.$eval(row('held-desk'), el => el.scrollIntoView({block:'center'}));
    await screenshot(label, 'virtual-desks-stop-confirmation');
    // A refusal from the server shows why and leaves the desk running.
    state.deskStopConflict = true;
    await clickWithin(row('held-desk'), 'Stop and interrupt');
    await rowHas('held-desk', 'reservation changed since the list was loaded');
    assert.equal(state.deskRuntime['held-desk'], 'active', 'a refused stop changes nothing');
    assert.equal(await cell('held-desk', 'Runtime'), 'active');
    await clickWithin(row('held-desk'), 'Stop');
    await page.waitForSelector(confirmation('held-desk'));
    reads = inventoryReads();
    await clickWithin(row('held-desk'), 'Stop and interrupt');
    await rowHas('held-desk', 'Desk stopped.');
    await runtimeIs('held-desk', 'inactive');
    await reread(reads);
    await runtimeIs('held-desk', 'inactive');
    assert.deepEqual(state.deskOwnerActions.at(-1), {action:'stop',slug:'held-desk',expected_lease_state:'reserved',expected_holder:'Worker chat',confirm_interruption:true});
    assert.equal(await page.$eval(`${row('held-desk')} .desk-badge`, el => el.dataset.availability), 'reserved', 'stopping leaves the reservation recorded');

    // Unknown reservation and runtime need the same confirmation as reserved.
    await clickWithin(row('unbound-desk'), 'Stop');
    await page.waitForSelector(confirmation('unbound-desk'));
    assert.match(await page.$eval(confirmation('unbound-desk'), el => el.textContent), /could not be verified, so a chat may be using it/);
    reads = inventoryReads();
    await clickWithin(row('unbound-desk'), 'Stop and interrupt');
    await rowHas('unbound-desk', 'Desk stopped.');
    await runtimeIs('unbound-desk', 'inactive');
    await reread(reads);
    // The outcome and the Runtime cell agree, also after the re-read.
    await runtimeIs('unbound-desk', 'inactive');
    assert.deepEqual(await buttons('unbound-desk'), ['Start'], 'the row follows the stopped runtime');
    assert.deepEqual(state.deskOwnerActions.at(-1), {action:'stop',slug:'unbound-desk',expected_lease_state:'unknown',expected_holder:null,confirm_interruption:true});
    assert.equal(await page.$eval(`${row('unbound-desk')} .desk-badge`, el => el.dataset.availability), 'unknown', 'stopping does not make an unknown desk look free');

    // An unknown outcome blocks that row until a refresh, which also clears it.
    state.deskStartFailure = true;
    await clickWithin(row('idle-desk'), 'Start');
    await rowHas('idle-desk', 'outcome needs checking');
    assert.equal(await page.$eval(`${row('idle-desk')} .desk-owner-buttons button`, el => el.disabled), true, 'no retry while the outcome is unknown');
    await clickWithin('[aria-label="Virtual desks"]', 'Refresh');
    await page.waitForFunction(selector => document.querySelector(selector)?.disabled === false, {}, `${row('idle-desk')} .desk-owner-buttons button`);
    await rowLacks('idle-desk', 'outcome needs checking');
    await rowLacks('idle-desk', 'The outcome is unknown');
    assert.equal(await detailShown('idle-desk'), false, 'a refresh clears the stale outcome notice');

    // Link: a validated URL, and what it hands over, only once it exists.
    await clickWithin(row('synthetic-desk'), 'Link');
    await page.waitForSelector(`${row('synthetic-desk')} .desk-link a`);
    assert.deepEqual(await page.$eval(`${row('synthetic-desk')} .desk-link a`, a => ({href:a.href,rel:a.rel,target:a.target})), {
        href:'https://desktop.example.test/desktop-share/synthetic-desk?key=fixture', rel:'noopener noreferrer', target:'_blank',
    });
    assert.match(await page.$eval(`${row('synthetic-desk')} .desk-link`, el => el.textContent), /full control.*until 2026-01-01T01:00:00Z.*Treat it like a password/s);
    assert.deepEqual(state.deskOwnerActions.at(-1), {action:'link',slug:'synthetic-desk'});
    assert.deepEqual(await buttons('synthetic-desk'), ['Stop'], 'the link is already on the row');
    // Collapse the chat controls again: the table view, and below, the reserve
    // flow must reopen them by itself so Release can never be hidden.
    await page.click(chatToggle);
    await page.waitForFunction(selector => document.querySelector(selector)?.hidden === true, {}, chatPanel);
    assert.equal(await page.$eval(chatToggle, el => el.getAttribute('aria-expanded')), 'false');
    await page.$eval('.desk-table', el => el.scrollIntoView());
    await screenshot(label, 'virtual-desks');
    const viewport=page.viewport();
    await page.setViewport({...viewport,width:390,height:844});
    await page.waitForFunction(()=>window.innerWidth===390);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.desk-main > td')).display!=='table-cell');
    const narrow = await page.evaluate(()=>{
        const rows=[...document.querySelectorAll('.desk-row:not([hidden])')];
        const cells=[...document.querySelectorAll('.desk-row:not([hidden]) .desk-main > td')];
        return {scroll:document.documentElement.scrollWidth, width:window.innerWidth,
            overflowing:rows.filter(row=>row.getBoundingClientRect().right>window.innerWidth+1).map(row=>row.getAttribute('aria-label')),
            unlabelled:cells.filter(cell=>getComputedStyle(cell,'::before').content.replace(/"/g,'')!==cell.dataset.label).map(cell=>cell.dataset.label),
            header:getComputedStyle(document.querySelector('.desk-table thead')).position};
    });
    assert.ok(narrow.scroll<=narrow.width,`desk table fits narrow screens (${narrow.scroll}px in ${narrow.width}px)`);
    assert.deepEqual(narrow.overflowing,[],'no desk row overflows');
    assert.deepEqual(narrow.unlabelled,[],'every stacked value carries its column label');
    assert.equal(narrow.header,'absolute','column headers stay for assistive technology only');
    await page.$eval('.desk-table', el => el.scrollIntoView());
    await screenshot(label,'virtual-desks-mobile');
    await page.$eval(row('unbound-desk'), el => el.scrollIntoView());
    await screenshot(label,'virtual-desks-mobile-rows');
    await page.setViewport(viewport);
    await clickWithin('[aria-label="Desk synthetic-desk"]','Reserve for 10 minutes');
    await waitText('Reserved for 10 minutes.');
    await page.waitForFunction(selector => document.querySelector(selector)?.hidden === false, {}, chatPanel);
    assert.deepEqual(await page.$eval(chatToggle, el => ({expanded:el.getAttribute('aria-expanded'), disabled:el.disabled})), {expanded:'true', disabled:true},
        'the chat controls cannot be collapsed while a reservation is held');
    await page.type('[aria-label="Virtual desks"] input[type="search"]','research');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Desk synthetic-desk"]').hidden);
    await page.$eval('[aria-label="Virtual desks"] input[type="search"]',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>!document.querySelector('[aria-label="Desk synthetic-desk"]').hidden);
    assert.ok((await page.$eval('[aria-label="Desk synthetic-desk"]',el=>el.textContent)).includes('Release reservation'),'search must retain the current fencing token and release action');
    assert.equal(await page.$eval(chatPanel,el=>el.hidden),false,'the release control stays visible while a reservation is held');
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"] details.desk-advanced',el=>el.open),false,'restart stays secondary and collapsed');
    await page.click('[aria-label="Desk synthetic-desk"] details.desk-advanced summary');
    assert.equal(await page.$eval('[aria-label="Desk synthetic-desk"] details.desk-advanced',el=>el.open),true,'advanced restart opens on request');
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
    assert.equal(state.deskOwnerActions.at(-1).action,'link','refresh must not repeat owner actions');
    assert.equal(state.deskOwnerActions.filter(a=>a.action==='link').length,1,'refresh must not mint another link');
    await clickText('Settings');
    await page.waitForSelector('#settings-model');
    await page.waitForSelector('[aria-label="Account settings"] .owner-password');
    assert.equal(new URL(page.url()).hash, `#conversation/${conversation}/settings`);
    assert.equal(await page.$$eval('.owner-password', nodes => nodes.length), 1);
    assert.equal(await page.$eval('.owner-password summary', n => n.textContent.trim()), 'Change password');
}
