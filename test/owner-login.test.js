import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { changeOwnerPassword, createOwnerLogin, ownerLoginStatus, verifyOwnerLogin, verifyOwnerToken } from "../packages/core/src/owner-login.js";
import { assertOidcDesktopSession } from "../packages/core/src/oidc-desktop-session.js";
import { principalFromSecuritySession } from "../packages/core/src/principal.js";
import { desktopCatalogFromEnv } from "../packages/core/src/runtime-settings.js";
import { publishRunAllowed } from "../scripts/security/workflow-policy.mjs";

async function home(prefix = "orkestr-owner-login-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("owner login: first password, signed token, wrong password, limits and revocation", async () => {
  const env = { ORKESTR_HOME: await home() };
  assert.deepEqual(await ownerLoginStatus(env), { configured: false, username: "" });
  await assert.rejects(createOwnerLogin({ username: "can", password: "short" }, env), /owner_password_too_short/);
  await assert.rejects(createOwnerLogin({ username: "bad name", password: "long-enough" }, env), /owner_username_invalid/);
  await createOwnerLogin({ username: "can", password: "first-password" }, env);
  await assert.rejects(createOwnerLogin({ username: "other", password: "another-password" }, env), /owner_login_exists/);
  const stat = await fs.stat(path.join(env.ORKESTR_HOME, "owner-login.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(path.join(env.ORKESTR_HOME, "owner-login.json"), "utf8")).includes("first-password"));

  const { token } = await verifyOwnerLogin({ username: "can", password: "first-password", clientKey: "a" }, env);
  assert.equal((await verifyOwnerToken(token, env)).sub, "can");
  const [header, body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), sub: "someone" })).toString("base64url");
  assert.equal(await verifyOwnerToken(`${header}.${forged}.${signature}`, env), null, "a changed token is rejected");
  assert.equal(await verifyOwnerToken(token, { ORKESTR_HOME: await home() }), null, "another install's key does not verify it");

  await assert.rejects(verifyOwnerLogin({ username: "can", password: "wrong-password", clientKey: "b" }, env), /owner_login_invalid/);
  for (let i = 0; i < 9; i += 1) await verifyOwnerLogin({ username: "can", password: "nope-nope", clientKey: "b" }, env).catch(() => {});
  await assert.rejects(verifyOwnerLogin({ username: "can", password: "first-password", clientKey: "b" }, env), /owner_login_rate_limited/);

  await changeOwnerPassword({ currentPassword: "first-password", newPassword: "second-password" }, env);
  assert.equal(await verifyOwnerToken(token, env), null, "changing the password signs out old tokens");
});

test("owner login over HTTP: first visit creates it, then the app needs the cookie", async () => {
  const keys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_OWNER_LOGIN_PROMPT", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ORKESTR_HOME = await home("orkestr-owner-http-");
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie = "") => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${base}/api/auth/owner`)).json(), { configured: false, signedIn: false, prompt: true });
    assert.equal((await fetch(`${base}/api/threads`)).status, 401);
    const setup = await post("/api/auth/owner/setup", { username: "can", password: "first-password" });
    assert.equal(setup.status, 200);
    const cookie = String(setup.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /^orkestr_owner=/);
    assert.match(String(setup.headers.get("set-cookie")), /HttpOnly; SameSite=Lax/);
    assert.equal((await post("/api/auth/owner/setup", { username: "someone", password: "takeover-pass" })).status, 409, "only the first visitor picks the login");
    assert.equal((await fetch(`${base}/api/threads`, { headers: { cookie } })).status, 200);
    const status = await (await fetch(`${base}/api/auth/owner`, { headers: { cookie } })).json();
    assert.equal(status.signedIn, true);
    const vault = await fetch(`${base}/api/vault/status`, { headers: { cookie } });
    assert.notEqual((await vault.json().catch(() => ({}))).error, "vault_owner_session_required", "the vault opens for the owner login");
    assert.equal((await post("/api/auth/owner/login", { username: "can", password: "wrong-password" })).status, 401);
    const login = await post("/api/auth/owner/login", { username: "can", password: "first-password" });
    assert.equal(login.status, 200);
    const logout = await post("/api/setup/security/logout", {}, cookie);
    assert.match(String(logout.headers.get("set-cookie")), /orkestr_owner=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the owner login opens desktops; other browser sessions still do not", () => {
  const ownerSession = { id: "owner-abc", userId: "admin", role: "admin", authProvider: "owner-password" };
  const principal = principalFromSecuritySession(ownerSession);
  assert.equal(principal.source, "owner-session");
  assert.equal(assertOidcDesktopSession(principal, ownerSession), principal);
  const paired = { id: "paired-1", userId: "admin", role: "admin" };
  assert.throws(() => assertOidcDesktopSession(principalFromSecuritySession(paired), paired), /oidc_desktop_session_required/);
});

test("Docker starts with one desktop; the publish job may only combine images with buildx", () => {
  assert.deepEqual(desktopCatalogFromEnv({ ORKESTR_DOCKER: "1" }).map((row) => row.slug), ["desktop"]);
  assert.deepEqual(desktopCatalogFromEnv({}).map((row) => row.slug), ["desktop", "linkedin", "gmail"]);
  assert.equal(publishRunAllowed('docker buildx imagetools create --tag "$IMAGE:latest" "$A" "$B"'), true);
  assert.equal(publishRunAllowed("docker buildx build ."), false);
  assert.equal(publishRunAllowed("docker run evil"), false);
});

test("browser helpers: copy fallback, WebCrypto stand-in, 0.0.0.0 redirect", async () => {
  const compat = await fs.readFile("apps/web/src/app/browser-compat.ts", "utf8");
  assert.match(compat, /doc\.execCommand\("copy"\)/);
  assert.match(compat, /new DOMException\("WebCrypto is unavailable on this page", "NotSupportedError"\)/);
  assert.match(compat, /location\.hostname !== "0\.0\.0\.0"/);
  const main = await fs.readFile("apps/web/src/main.ts", "utf8");
  assert.match(main, /const redirecting = redirectZeroHostToLocalhost\(\);\s*installWebCryptoFallbackShim\(\);/);
  for (const file of ["pairing-required-page.component.ts", "shared-app-page.component.ts", "codex-sign-in-panel.component.ts", "ops-page.component.ts", "vault-secrets.ts"]) {
    const source = await fs.readFile(`apps/web/src/app/${file}`, "utf8");
    assert.match(source, /copyText\(/, file);
    assert.doesNotMatch(source, /clipboard\?\.writeText\(/, file);
  }
});

test("first visit in a browser: create the login, then Orkestr opens", { timeout: 120_000 }, async (t) => {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    return t.skip("Puppeteer is not installed for browser e2e.");
  }
  const chrome = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
  let executablePath = "";
  for (const candidate of chrome) if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  if (!executablePath) return t.skip("No Chrome for browser e2e.");
  if (!(await fs.access("dist/web/browser/index.html").then(() => true, () => false))) return t.skip("Web bundle not built.");
  const keys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_OWNER_LOGIN_PROMPT", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ORKESTR_HOME = await home("orkestr-owner-browser-");
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Create your login"), { timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.body.innerText.includes("docker exec")), false, "no command needed");
    await page.type("input[name='owner-username']", "can");
    await page.type("input[name='owner-password']", "first-password");
    await page.type("input[name='owner-password-repeat']", "first-password");
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Create login").click());
    await page.waitForFunction(() => !document.body.innerText.includes("Create your login") && (document.querySelector(".runtime-gate-shell") || document.querySelector(".app-shell")), { timeout: 30_000 });
    const cookies = await page.cookies();
    assert.ok(cookies.some((cookie) => cookie.name === "orkestr_owner" && cookie.httpOnly), "signed in with the owner cookie");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
