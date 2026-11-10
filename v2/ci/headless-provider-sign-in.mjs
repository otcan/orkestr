// Real WASM view acceptance, called by the existing isolated workspace harness.
import assert from 'node:assert/strict';

const row = '[aria-label="Codex sign-in"]';

export async function providerSignIn({page, state, clickWithin, waitText, screenshot, label}) {
    await waitText('Provider sign-in');
    await waitText("V1's Codex uses the same Codex sign-in.");
    await waitText('Not enabled on this server.');
    assert.equal(await page.$('[aria-label="Claude sign-in"] button'), null, 'an unconfigured provider offers no actions');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Not signed in.'), {}, row);
    await screenshot(label, 'provider-sign-in-idle');

    await clickWithin(row, 'Sign in');
    await page.waitForSelector(`${row} a[target="_blank"]`);
    assert.deepEqual(await page.$eval(`${row} a`, a => ({href:a.href,rel:a.rel})), {
        href:'https://auth.openai.com/codex/device', rel:'noopener noreferrer',
    });
    assert.equal(await page.$eval(`${row} .provider-sign-in-code`, n => n.textContent), 'ABCD-EFGH1');
    assert.deepEqual(state.signInPosts.at(-1), {provider:'codex', action:'start', request:{}});
    await screenshot(label, 'provider-sign-in-waiting');

    // A link that is not the provider's own https sign-in page is never a link.
    state.signIn.codex.login.link = 'https://evil.example/codex/device';
    await page.waitForFunction(selector => !document.querySelector(`${selector} a`), {timeout: 15000}, row);
    await waitText('could not be verified');
    assert.equal(await page.$(`${row} a[href*="evil"]`), null);
    state.signIn.codex.login.link = 'https://auth.openai.com/codex/device';
    await page.waitForSelector(`${row} a[target="_blank"]`);

    // The reply to the cancel carries the next state, so no idle poll is awaited.
    state.signIn.codex.signed_in = true;
    state.signIn.codex.method = 'chatgpt';
    await clickWithin(row, 'Cancel');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Sign-in cancelled'), {}, row);
    assert.equal(state.signInPosts.at(-1).action, 'cancel');
    assert.equal(await page.$(`${row} a`), null, 'the link is gone once the sign-in has ended');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Signed in with ChatGPT.'), {}, row);
    const posts = state.signInPosts.length;
    await clickWithin(row, 'Sign out');
    await waitText('Sign out of Codex for this whole server?');
    const warning = await page.$eval(`${row} [role="alert"]`, n => n.textContent);
    assert.match(warning, /also signs out V1's Codex/);
    assert.match(warning, /next release cannot deploy \(provider_credentials_not_ready\)/);
    assert.equal(state.signInPosts.length, posts, 'asking for confirmation has no effect');
    await clickWithin(row, 'Keep signed in');
    await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} button`)].some(b => b.textContent === 'Sign out'), {}, row);
    assert.equal(state.signInPosts.length, posts, 'keeping the session has no effect');
    await clickWithin(row, 'Sign out');
    await waitText('Sign out of Codex for this whole server?');
    await clickWithin(row, 'Confirm sign out');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Not signed in.'), {}, row);
    assert.deepEqual(state.signInPosts.at(-1), {provider:'codex', action:'sign-out', request:{confirm:true}});
    await screenshot(label, 'provider-sign-in-signed-out');
}
