import assert from 'node:assert/strict';

export async function submitLogin(page, origin, click, setup = false) {
  // Register both exact responses BEFORE the click; setup starts login internally.
  const expected = setup ? [['/api/v2/setup', 201], ['/api/v2/browser/session', 200]]
    : [['/api/v2/browser/session', 200]];
  const responses = expected.map(([path]) => page.waitForResponse(response =>
    response.url() === `${origin}${path}` && response.request().method() === 'POST',
  { timeout: 10000 }));
  const [received] = await Promise.all([Promise.all(responses), click('Continue')]);
  received.forEach((response, index) => assert.equal(response.status(), expected[index][1], 'Authentication POST failed'));
  // Receipt of Set-Cookie alone does not prove the application consumed login.
  await page.waitForFunction(() => !document.querySelector('#username')
    && [...document.querySelectorAll('button')].some(button => button.textContent === 'Sign out'),
  { timeout: 10000 });
  const cookie = (await page.browser().cookies()).find(value => value.name === 'orkestr_v2_session');
  assert.ok(cookie?.httpOnly, 'Authenticated cookie missing');
  assert.equal(cookie.sameSite, 'Strict');
}
