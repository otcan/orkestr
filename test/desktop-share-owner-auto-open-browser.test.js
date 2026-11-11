// ORK-793: desk links live on a link host of their own (connect.<domain>)
// while the Orkestr session cookie belongs to the app host. A signed-in owner
// must reach the desktop without a click; a signed-out visitor keeps the
// button; revoked and expired links never open.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { createOwnerLogin, verifyOwnerLogin } from "../packages/core/src/owner-login.js";
import { createDesktopShare, revokeDesktopShare } from "../packages/core/src/desktop-shares.js";
import { readDesktopShareState } from "../packages/core/src/desktop-share-store.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_PUBLIC_APP_URL", "ORKESTR_DESKTOP_SHARE_URL_TEMPLATE", "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED", "ORKESTR_OWNER_LOGIN_PROMPT"];

// One server for two hosts of one site, as behind the production proxy: the
// app host and the link host that share links point at.
async function withDeskServer(run) {
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desk-link-auto-open-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  try {
    const port = server.address().port;
    const appOrigin = `http://app.orkestr.test:${port}`;
    const linkOrigin = `http://connect.orkestr.test:${port}`;
    process.env.ORKESTR_PUBLIC_APP_URL = appOrigin;
    process.env.ORKESTR_DESKTOP_SHARE_URL_TEMPLATE = `${linkOrigin}/desktop-share/{subdomain}/{shareId}?key={key}`;
    const env = process.env;
    await createOwnerLogin({ username: "owner", password: "owner-password-fixture" }, env);
    const { token } = await verifyOwnerLogin({ username: "owner", password: "owner-password-fixture", clientKey: "desk-link-test" }, env);
    const newShare = async (desktopSlug) => {
      const created = await createDesktopShare({ desktopSlug, principal: { kind: "user", userId: "admin", role: "admin" }, env });
      assert.ok(created.url.startsWith(`${linkOrigin}/desktop-share/`), "links point at the link host");
      const url = new URL(created.url);
      return { url: created.url, id: url.pathname.split("/").filter(Boolean).at(-1), key: url.searchParams.get("key"), subdomain: created.subdomain };
    };
    const expire = async (shareId) => {
      const statePath = path.join(home, "secrets", "desktop-shares.json");
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      state.desktopShares.find((share) => share.id === shareId).expiresAt = new Date(Date.now() - 60_000).toISOString();
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    };
    const approvedAttempts = async (shareId) => {
      const state = await readDesktopShareState(env);
      return (state.desktopShares.find((share) => share.id === shareId)?.attempts || []).filter((attempt) => attempt.status === "approved");
    };
    await run({ port, appOrigin, linkOrigin, token, env, newShare, expire, approvedAttempts });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("owner-session check: read-only, owner only, readable only by the link host", { timeout: 60_000 }, async () => {
  await withDeskServer(async ({ port, linkOrigin, token, env, newShare, expire, approvedAttempts }) => {
    const share = await newShare("check-desk");
    const check = (target, { cookie = `orkestr_owner=${token}`, origin = linkOrigin, key = target.key } = {}) => fetch(
      `http://127.0.0.1:${port}/api/desktop-shares/${encodeURIComponent(target.id)}/owner-session?key=${encodeURIComponent(key)}&subdomain=${encodeURIComponent(target.subdomain)}`,
      { headers: { host: `app.orkestr.test:${port}`, accept: "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } },
    );
    const owner = await check(share);
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { ok: true, owner: true });
    assert.equal(owner.headers.get("access-control-allow-origin"), linkOrigin);
    assert.equal(owner.headers.get("access-control-allow-credentials"), "true");
    assert.match(owner.headers.get("vary") || "", /origin/i);
    assert.match(owner.headers.get("cache-control") || "", /no-store/);
    assert.equal((await approvedAttempts(share.id)).length, 0, "the check approves nothing");

    const foreign = await check(share, { origin: `http://other.orkestr.test:${port}` });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null, "no other origin may read the answer");
    const signedOut = await check(share, { cookie: "" });
    assert.equal(signedOut.status, 401);
    assert.notEqual((await signedOut.json()).owner, true);
    assert.equal((await check(share, { key: "wrong-key-value" })).status, 401);

    const revoked = await newShare("revoked-check-desk");
    await revokeDesktopShare(revoked.id, { env });
    assert.equal((await check(revoked)).status, 401, "revoked links are never the owner's to open");
    const expired = await newShare("expired-check-desk");
    await expire(expired.id);
    assert.equal((await check(expired)).status, 401, "expired links are never the owner's to open");
  });
});

async function chromeOrSkip(t) {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    t.skip("Puppeteer is not installed for browser e2e.");
    return null;
  }
  for (const candidate of [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)) {
    if (await fs.access(candidate).then(() => true, () => false)) return { puppeteer, executablePath: candidate };
  }
  t.skip("No Chrome for browser e2e.");
  return null;
}

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("headless: on the link host the signed-in owner opens without a click, others keep the button", { timeout: 120_000 }, async (t) => {
  const chrome = await chromeOrSkip(t);
  if (!chrome) return;
  await withDeskServer(async ({ appOrigin, linkOrigin, token, env, newShare, expire, approvedAttempts }) => {
    const browser = await chrome.puppeteer.launch({
      headless: true,
      executablePath: chrome.executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--host-resolver-rules=MAP *.orkestr.test 127.0.0.1"],
    });
    try {
      const visit = async (url, { signedIn }) => {
        const context = await browser.createBrowserContext();
        if (signedIn) {
          // The owner's session cookie, host-only on the app host as in production.
          await context.setCookie({ name: "orkestr_owner", value: token, domain: "app.orkestr.test", path: "/", httpOnly: true, sameSite: "Lax" });
        }
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return { context, page };
      };
      const ownerButton = (page) => page.evaluate(() => {
        const owner = document.getElementById("owner");
        return Boolean(owner && !owner.hidden) && owner.getAttribute("href");
      }).catch(() => false);

      // Signed out: the button stays, nothing moves or gets approved.
      const forVisitor = await newShare("visitor-desk");
      const visitor = await visit(forVisitor.url, { signedIn: false });
      const visitorUrl = new URL(forVisitor.url);
      assert.equal(await waitFor(() => ownerButton(visitor.page)), `${appOrigin}${visitorUrl.pathname}${visitorUrl.search}`);
      assert.ok(visitor.page.url().startsWith(`${linkOrigin}/desktop-share/`), "a signed-out visitor stays on the link");
      assert.equal((await approvedAttempts(forVisitor.id)).length, 0);
      await visitor.context.close();

      // Signed in: the desktop opens with no click.
      const forOwner = await newShare("owner-desk");
      const owner = await visit(forOwner.url, { signedIn: true });
      const landed = await waitFor(() => owner.page.url().startsWith(`${appOrigin}/desktop/owner-desk/`));
      assert.ok(landed, `the owner reaches the desktop without a click (at ${owner.page.url()})`);
      const approved = await approvedAttempts(forOwner.id);
      assert.equal(approved.length, 1, "exactly the owner's app-host attempt is approved");
      assert.match(approved[0].approvedBy, /^oidc-session:owner-/);
      await owner.context.close();

      // Revoked and expired links never open, even for the signed-in owner.
      const revoked = await newShare("revoked-desk");
      await revokeDesktopShare(revoked.id, { env });
      const expired = await newShare("expired-desk");
      await expire(expired.id);
      for (const [share, word] of [[revoked, "revoked"], [expired, "expired"]]) {
        const dead = await visit(share.url, { signedIn: true });
        const said = await waitFor(() => dead.page.$eval("#summary", (node, text) => node.textContent.includes(text), word).catch(() => false));
        assert.ok(said, `${word}: the page says so`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.ok(dead.page.url().startsWith(`${linkOrigin}/desktop-share/`), `${word}: never moves on`);
        assert.equal(await ownerButton(dead.page), false, `${word}: no open button`);
        assert.equal((await approvedAttempts(share.id)).length, 0, `${word}: nothing approved`);
        await dead.context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
