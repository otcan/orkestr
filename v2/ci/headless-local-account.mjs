// CI-only account-form rendering against a synthetic gateway. The real Python
// gateway and first-owner transaction are covered by per-architecture image CI.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {startMock, A} from './headless-workspace-mock.mjs';

assert.equal(process.env.CI, 'true', 'Run only in isolated CI');
const {server, origin} = await startMock(process.env.UI_BUNDLE_DIR);
let browser, owner, signedIn = false, creations = 0;
const session = {csrf_token:'synthetic-csrf', global_conversation_id:A};
try {
    browser = await puppeteer.launch({headless:true, args:['--no-sandbox']});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        const reply = (status, value) => request.respond({status, contentType:'application/json',
            headers:{'Cache-Control':'no-store'}, body:JSON.stringify(value)});
        if (path === '/api/v2/oss-setup/account') {
            assert.equal(request.headers()['x-orkestr-local-setup'], '1');
            assert.equal(request.headers()['x-orkestr-bootstrap'], undefined);
            if (request.method() === 'GET') return reply(200, {setup_required:!owner});
            assert.equal(request.headers().origin, origin);
            const credentials = JSON.parse(request.postData());
            if (owner) return reply(409, {message:'An account already exists. Sign in instead.'});
            if (credentials.password.length < 12) return reply(400, {message:'Choose a password of at least 12 characters.'});
            owner = credentials; creations++;
            return reply(201, {created:true});
        }
        if (path === '/api/v2/browser/session') {
            if (request.method() === 'DELETE') { signedIn = false; return request.respond({status:204}); }
            if (request.method() === 'POST') {
                const credentials = JSON.parse(request.postData());
                signedIn = owner && credentials.username === owner.username && credentials.password === owner.password;
            }
            return reply(signedIn ? 200 : 401, signedIn ? session : {message:'Sign in required'});
        }
        return request.continue();
    });
    const click = async label => {
        await page.waitForFunction(label => [...document.querySelectorAll('button')]
            .some(button => button.textContent.trim() === label && !button.disabled), {}, label);
        await page.evaluate(label => [...document.querySelectorAll('button')]
            .find(button => button.textContent.trim() === label).click(), label);
    };
    await page.goto(origin, {waitUntil:'networkidle2'});
    await page.waitForFunction(() => document.querySelector('h2')?.textContent === 'Create your account');
    assert.equal(await page.$('#bootstrap'), null, 'Local first run must not ask for a token');
    await page.type('#username', 'synthetic-owner');
    await page.type('#password', 'short');
    await click('Continue');
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('12 characters'));
    assert.equal(creations, 0);
    assert.equal(await page.$('#bootstrap'), null, 'Validation retry must keep the password-only form');
    await page.type('#password', 'synthetic-password-000000');
    await click('Continue');
    await page.waitForFunction(() => !document.querySelector('#username')
        && [...document.querySelectorAll('button')].some(button => button.textContent === 'Sign out'));
    assert.equal(creations, 1, 'First account must be created exactly once');
    await page.reload({waitUntil:'networkidle2'});
    await click('Sign out');
    await page.waitForFunction(() => document.querySelector('h2')?.textContent === 'Sign in'
        && !document.querySelector('button[type="submit"]')?.disabled);
    assert.equal(await page.$('#bootstrap'), null);
    await page.type('#username', 'synthetic-owner');
    await page.type('#password', 'synthetic-password-000000');
    await click('Continue');
    await page.waitForFunction(() => !document.querySelector('#username'));
    assert.equal(creations, 1, 'Existing-owner sign-in must not recreate the account');
    assert.deepEqual(errors, []);
    console.log('PASS: local first run, password validation retry, automatic sign-in, reload and existing-owner sign-in');
} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
