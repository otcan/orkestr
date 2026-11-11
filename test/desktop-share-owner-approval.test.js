// A desktop share link opened in the owner's own signed-in browser is approved
// by that session (no challenge to paste into chat); anyone else still needs
// the chat approval.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopShare, desktopShareStatus, openDesktopShare, revokeDesktopShare } from "../packages/core/src/desktop-shares.js";
import { approveDesktopShareAsOwner, verifyDesktopShareOwnerSession } from "../packages/core/src/desktop-share-owner-approval.js";
import { desktopSharePageOrigin } from "../packages/core/src/desktop-share-http.js";
import { createOidcSecuritySession } from "../packages/core/src/security.js";

async function oidcOwner(env, subject, name) {
  const oidc = await createOidcSecuritySession({ subject, displayName: name, issuedAt: new Date().toISOString(), env });
  return {
    principal: { kind: "user", userId: oidc.session.userId, role: "user", source: "oidc-session", sessionId: oidc.session.id, displayName: name },
    securitySession: { ...oidc.session, authProvider: "oidc" },
  };
}

test("the signed-in owner approves their own share link attempt; others cannot", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-owner-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test", ORKESTR_DESKTOP_SHARE_BASE_DOMAIN: "desktop.example.test" };
  const alice = await oidcOwner(env, "alice-subject", "Alice");
  const bob = await oidcOwner(env, "bob-subject", "Bob");
  const created = await createDesktopShare({ desktopSlug: "example-desk", principal: alice.principal, env });
  const url = new URL(created.url);
  const shareId = url.pathname.split("/").filter(Boolean).at(-1);
  const key = url.searchParams.get("key");
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env, request: { headers: { "user-agent": "test" } } });
  const browserToken = opened.cookie.value.split(":")[1];
  const base = { shareId, key, browserToken, subdomain: created.subdomain, env };

  // Not a sign-in session (e.g. a machine or paired-device principal).
  await assert.rejects(() => approveDesktopShareAsOwner({ ...base, principal: { ...alice.principal, source: "pairing" }, securitySession: alice.securitySession }), { statusCode: 401 });
  // Another user's session.
  await assert.rejects(() => approveDesktopShareAsOwner({ ...base, ...bob }), { statusCode: 403 });
  // The link key is still required.
  await assert.rejects(() => approveDesktopShareAsOwner({ ...base, key: "wrong-key-value", ...alice }));
  // A browser that never opened the link has no attempt to approve.
  await assert.rejects(() => approveDesktopShareAsOwner({ ...base, browserToken: "", ...alice }), { statusCode: 409 });
  assert.equal((await desktopShareStatus(base)).approved, false);

  const approved = await approveDesktopShareAsOwner({ ...base, ...alice });
  assert.equal(approved.approved, true);
  assert.match(approved.desktopUrl, /^\/desktop\/example-desk\/vnc\.html/);
  const status = await desktopShareStatus(base);
  assert.equal(status.approved, true);
  // Idempotent for the same browser.
  assert.equal((await approveDesktopShareAsOwner({ ...base, ...alice })).approved, true);

  // A second browser (someone the link was forwarded to) stays pending.
  const other = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env, request: { headers: { "user-agent": "other" } } });
  assert.equal((await desktopShareStatus({ ...base, browserToken: other.cookie.value.split(":")[1] })).approved, false);
});

// ORK-793: the link host asks the app host whether this browser is signed in
// as the link's owner before moving there. The check approves nothing and
// keeps every share check: key, expiry, revocation and owner identity.
test("the owner-session check passes only for the owner's live link and approves nothing", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-owner-check-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test", ORKESTR_DESKTOP_SHARE_BASE_DOMAIN: "desktop.example.test" };
  const alice = await oidcOwner(env, "alice-subject", "Alice");
  const bob = await oidcOwner(env, "bob-subject", "Bob");
  const share = async () => {
    const created = await createDesktopShare({ desktopSlug: "example-desk", principal: alice.principal, env });
    const url = new URL(created.url);
    return { shareId: url.pathname.split("/").filter(Boolean).at(-1), key: url.searchParams.get("key"), subdomain: created.subdomain, env };
  };

  const live = await share();
  const verified = await verifyDesktopShareOwnerSession({ ...live, ...alice });
  assert.equal(verified.ok, true);
  assert.equal(verified.attempt, null, "no browser attempt is read or created");
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...live }), { statusCode: 401 }, "signed out");
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...live, principal: { ...alice.principal, source: "pairing" }, securitySession: alice.securitySession }), { statusCode: 401 }, "not a sign-in session");
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...live, ...bob }), { statusCode: 403 }, "another owner");
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...live, key: "wrong-key-value", ...alice }), /desktop_share_key_invalid/);
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...live, subdomain: "other-label", ...alice }), /desktop_share_subdomain_invalid/);
  const opened = await openDesktopShare({ ...live, request: { headers: { "user-agent": "test" } } });
  const browserToken = opened.cookie.value.split(":")[1];
  await verifyDesktopShareOwnerSession({ ...live, ...alice });
  assert.equal((await desktopShareStatus({ ...live, browserToken })).approved, false, "checking approves nothing");

  await revokeDesktopShare(live.shareId, { env });
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...live, ...alice }), /desktop_share_revoked/);
  await assert.rejects(() => approveDesktopShareAsOwner({ ...live, browserToken, ...alice }), /desktop_share_revoked/);

  const expiring = await share();
  const statePath = path.join(home, "secrets", "desktop-shares.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.desktopShares.find((item) => item.id === expiring.shareId).expiresAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(() => verifyDesktopShareOwnerSession({ ...expiring, ...alice }), /desktop_share_expired/);
});

test("only the configured link host may read the owner-session check across origins", () => {
  const env = { ORKESTR_DESKTOP_SHARE_URL_TEMPLATE: "https://connect.example.test/desktop-share/{subdomain}/{shareId}?key={key}" };
  assert.equal(desktopSharePageOrigin("https://connect.example.test", env), "https://connect.example.test");
  for (const origin of ["", "null", "https://evil.example.test", "http://connect.example.test", "https://connect.example.test:8443", "https://app.example.test", "https://connect.example.test.evil.test"]) {
    assert.equal(desktopSharePageOrigin(origin, env), "", origin);
  }
  assert.equal(desktopSharePageOrigin("https://connect.example.test", {}), "", "no template, no cross-origin reader");
  assert.equal(desktopSharePageOrigin("https://x.desktop.example.test", { ORKESTR_DESKTOP_SHARE_URL_TEMPLATE: "https://{subdomain}.desktop.example.test/desktop-share/{shareId}?key={key}" }), "", "per-link hosts are not trusted readers");
  assert.equal(desktopSharePageOrigin("https://connect.example.test", { ORKESTR_DESKTOP_SHARE_URL_TEMPLATE: "https://user:pass@connect.example.test/desktop-share/{shareId}" }), "");
  assert.equal(desktopSharePageOrigin("javascript:alert(1)", { ORKESTR_DESKTOP_SHARE_URL_TEMPLATE: "javascript:alert(1)" }), "");
});
