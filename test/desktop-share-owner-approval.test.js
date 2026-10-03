// A desktop share link opened in the owner's own signed-in browser is approved
// by that session (no challenge to paste into chat); anyone else still needs
// the chat approval.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopShare, desktopShareStatus, openDesktopShare } from "../packages/core/src/desktop-shares.js";
import { approveDesktopShareAsOwner } from "../packages/core/src/desktop-share-owner-approval.js";
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
