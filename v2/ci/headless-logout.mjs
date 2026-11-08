import assert from 'node:assert/strict';

// CI-only synthetic session. A 503 is not proof that its cookie was revoked.
// Reconcile that exact session before one further visible sign-out gesture;
// an unobserved response or unavailable reconciliation is never retried.
export async function submitLogout(page, origin, click) {
  const revoke = async () => {
    const pending = page.waitForResponse(response =>
      response.url() === `${origin}/api/v2/browser/session`
        && response.request().method() === 'DELETE', { timeout: 10000 });
    const [response] = await Promise.all([pending, click('Sign out')]);
    return response.status();
  };
  let status = await revoke();
  if (status === 503) {
    const current = await page.evaluate(async () => (await fetch('/api/v2/browser/session', {
      redirect: 'error', cache: 'no-store',
    })).status);
    assert.ok(current === 200 || current === 401, 'Sign-out session reconciliation unavailable');
    if (current === 401) {
      await page.reload({ waitUntil: 'networkidle2' });
      status = 401;
    } else {
      await page.waitForFunction(() =>
        document.querySelector('.app-notice')?.textContent.includes('Sign-out not confirmed.')
          && [...document.querySelectorAll('button')].some(button =>
            button.textContent === 'Sign out' && !button.disabled), { timeout: 10000 });
      status = await revoke();
    }
  }
  assert.ok(status === 204 || status === 401, 'Server did not confirm session revocation');
  await page.waitForSelector('#username', { timeout: 10000 });
}
