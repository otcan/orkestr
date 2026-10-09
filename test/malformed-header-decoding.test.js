// Cookie and Authorization header values are attacker-controlled. A malformed
// percent-escape must read as an empty value, never throw a URIError that
// surfaces as a 500. Synthetic values and hosts only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cookieHeaderValue, cookieHeaderValues, decodeComponentOrEmpty } from "../packages/core/src/cookie-header.js";
import { parseDesktopShareCookie } from "../packages/core/src/desktop-share-http.js";
import { exchangeMcpToken } from "../packages/core/src/mcp-oauth.js";
import { rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

const MALFORMED = "%E0%A4%A";

test("cookie header helpers decode values and drop malformed escapes", () => {
  assert.equal(decodeComponentOrEmpty("a%3Ab"), "a:b");
  assert.equal(decodeComponentOrEmpty(MALFORMED), "");
  assert.equal(cookieHeaderValue("other=1; orkestr_session=tok%2Den", "orkestr_session"), "tok-en");
  assert.equal(cookieHeaderValue(`orkestr_session=${MALFORMED}`, "orkestr_session"), "");
  assert.deepEqual(cookieHeaderValues(`s=${MALFORMED}; s=good; s=a=b`, "s"), ["good", "a=b"]);
  assert.deepEqual(cookieHeaderValues("", "s"), []);
});

test("a malformed desktop share cookie reads as an empty token", async () => {
  assert.deepEqual(parseDesktopShareCookie("orkestr_desktop_share=share-1%3Atoken-1"), { shareId: "share-1", token: "token-1" });
  assert.deepEqual(parseDesktopShareCookie(`orkestr_desktop_share=${MALFORMED}`), { shareId: "", token: "" });
  const { desktopShareBrowserToken } = await import("../dist/server/apps/server/src/modules/browsers/desktop-share-owner.controller.js");
  assert.equal(desktopShareBrowserToken({ headers: { cookie: `orkestr_desktop_share=${MALFORMED}` } }), "");
  assert.equal(desktopShareBrowserToken({ headers: { cookie: "orkestr_desktop_share=share-1%3Atoken-1" } }), "token-1");
});

test("a malformed Basic client credential is an OAuth error, not a URIError", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mcp-basic-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const authorization = `Basic ${Buffer.from(`${MALFORMED}:${MALFORMED}`).toString("base64")}`;
  await assert.rejects(
    exchangeMcpToken({ grant_type: "authorization_code" }, authorization, { ...process.env, ORKESTR_HOME: home }),
    (error) => !(error instanceof URIError) && /invalid_client/.test(String(error.code || error.error || error.message)),
  );
});

test("malformed cookies never turn into server errors", async (t) => {
  const server = await startFixtureServer({ ORKESTR_HOST_BOUNDARIES: "0" });
  t.after(() => server.close());
  const { port } = server;
  const cookie = `orkestr_session=${MALFORMED}; orkestr_desktop_share=${MALFORMED}`;
  const health = await rawRequest(port, { pathname: "/api/health", headers: { cookie } });
  assert.ok(health.status < 500, `${health.status} ${health.text}`);
  const approve = await rawRequest(port, {
    method: "POST",
    pathname: "/api/desktop-shares/share-1/approve-as-owner?key=k",
    headers: { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.ok(approve.status < 500, `${approve.status} ${approve.text}`);
});
