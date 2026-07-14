import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approveDesktopShareChallenge,
  authorizeDesktopShareHttpRequest,
  createDesktopShare,
  desktopShareRenewalHint,
  desktopShareStatus,
  openDesktopShare,
} from "../packages/core/src/desktop-shares.js";
import {
  parseTenantDesktopSharePath,
  rewriteTenantDesktopUrl,
  tenantDesktopSharePath,
  tenantDesktopShareUrlTemplate,
} from "../packages/core/src/tenant-desktop-share-routing.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread, enqueueThreadInput } from "../packages/core/src/threads.js";
import { completeThreadSecurityApproveCommand } from "../packages/core/src/security-thread-command.js";

function urlParts(value) {
  const parsed = new URL(value);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return {
    parsed,
    shareId: parts.at(-1),
    key: parsed.searchParams.get("key"),
  };
}

test("desktop shares require a random subdomain, link key, and per-browser chat challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_SHARE_BASE_DOMAIN: "desktop.example.test",
  };
  const principal = userPrincipal({ id: "alice", role: "user" });

  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const { parsed, shareId, key } = urlParts(created.url);
  const linkTtlMs = Date.parse(created.share.expiresAt) - Date.parse(created.share.createdAt);
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env, request: { headers: { "user-agent": "test" } } });
  const secondBrowser = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env, request: { headers: { "user-agent": "other" } } });
  const pending = await desktopShareStatus({
    shareId,
    key,
    browserToken: opened.cookie.value.split(":")[1],
    subdomain: created.subdomain,
    env,
  });
  const approved = await approveDesktopShareChallenge(opened.attempt.challenge, { env, approvedBy: "whatsapp-thread" });
  const ready = await desktopShareStatus({
    shareId,
    key,
    browserToken: opened.cookie.value.split(":")[1],
    subdomain: created.subdomain,
    env,
  });
  const auth = await authorizeDesktopShareHttpRequest({
    url: "/desktop/linkedin/vnc.html?autoconnect=1",
    headers: { cookie: `orkestr_desktop_share=${encodeURIComponent(opened.cookie.value)}` },
  }, env);

  assert.equal(parsed.hostname, `${created.subdomain}.desktop.example.test`);
  assert.equal(created.share.ownerUserId, "alice");
  assert.ok(linkTtlMs >= 55 * 60 * 1000 && linkTtlMs <= 65 * 60 * 1000);
  assert.match(key, /^[A-Za-z0-9_-]{30,}$/);
  assert.match(opened.attempt.challenge, /^desk-[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(opened.attempt.challenge, secondBrowser.attempt.challenge);
  assert.equal(pending.approved, false);
  assert.equal(approved.share.desktopSlug, "linkedin");
  assert.equal(ready.approved, true);
  assert.equal(ready.desktopUrl, "/desktop/linkedin/vnc.html?autoconnect=1&resize=scale&path=desktop/linkedin/websockify");
  assert.equal(auth.principal.userId, "alice");
  await assert.rejects(() => authorizeDesktopShareHttpRequest({
    url: "/desktop/gmail/vnc.html",
    headers: { cookie: `orkestr_desktop_share=${encodeURIComponent(opened.cookie.value)}` },
  }, env), /desktop_share_slug_forbidden/);
});

test("desktop shares supersede older pending and active shares for the same owner desktop", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-supersede-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  };
  const principal = userPrincipal({ id: "alice", role: "user" });

  const first = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const firstParts = urlParts(first.url);
  const firstOpened = await openDesktopShare({
    shareId: firstParts.shareId,
    key: firstParts.key,
    subdomain: first.subdomain,
    env,
  });
  const second = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const secondParts = urlParts(second.url);

  await assert.rejects(
    () => approveDesktopShareChallenge(firstOpened.attempt.challenge, { env, approvedBy: "stale-thread" }),
    /desktop_share_challenge_not_found/,
  );
  await assert.rejects(
    () => openDesktopShare({ shareId: firstParts.shareId, key: firstParts.key, subdomain: first.subdomain, env }),
    /desktop_share_superseded/,
  );

  const secondOpened = await openDesktopShare({
    shareId: secondParts.shareId,
    key: secondParts.key,
    subdomain: second.subdomain,
    env,
  });
  await approveDesktopShareChallenge(secondOpened.attempt.challenge, { env, approvedBy: "whatsapp-thread" });
  const authorized = await authorizeDesktopShareHttpRequest({
    url: "/desktop/linkedin/vnc.html?autoconnect=1",
    headers: { cookie: `orkestr_desktop_share=${encodeURIComponent(secondOpened.cookie.value)}` },
  }, env);
  assert.equal(authorized.principal.userId, "alice");

  await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  await assert.rejects(
    () => authorizeDesktopShareHttpRequest({
      url: "/desktop/linkedin/vnc.html?autoconnect=1",
      headers: { cookie: `orkestr_desktop_share=${encodeURIComponent(secondOpened.cookie.value)}` },
    }, env),
    /desktop_share_superseded/,
  );
});

test("desktop shares support path-based public challenge links", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-path-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  };
  const principal = userPrincipal({ id: "alice", role: "user" });

  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const { parsed, shareId, key } = urlParts(created.url);
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  const opened = await openDesktopShare({
    shareId,
    key,
    subdomain: created.subdomain,
    env,
    request: { headers: { "user-agent": "path-link-test" } },
  });
  const browserToken = opened.cookie.value.split(":")[1];
  const pending = await desktopShareStatus({ shareId, key, browserToken, subdomain: created.subdomain, env });
  await approveDesktopShareChallenge(opened.attempt.challenge, { env, approvedBy: "whatsapp-thread" });
  const ready = await desktopShareStatus({ shareId, key, browserToken, subdomain: created.subdomain, env });

  assert.equal(parsed.origin, "https://app.example.test");
  assert.deepEqual(pathParts.slice(0, 2), ["desktop-share", created.subdomain]);
  assert.equal(pathParts[2], shareId);
  assert.equal(created.wildcardSubdomainConfigured, false);
  assert.match(key, /^[A-Za-z0-9_-]{30,}$/);
  assert.match(opened.attempt.challenge, /^desk-[A-Za-z0-9_-]{20,}$/);
  assert.match(opened.cookie.header, /;\s*Secure\b/);
  assert.equal(pending.approved, false);
  assert.equal(pending.desktopUrl, "");
  assert.equal(ready.approved, true);
  assert.equal(ready.desktopUrl, "/desktop/linkedin/vnc.html?autoconnect=1&resize=scale&path=desktop/linkedin/websockify");
});

test("tenant desktop share routing uses parent path and rewrites approved desktop URLs", () => {
  const template = tenantDesktopShareUrlTemplate("Tenant Demo VM", "https://app.example.test/");
  const sharePath = tenantDesktopSharePath({
    tenantVmId: "Tenant Demo VM",
    subdomain: "d-abc123",
    shareId: "share-1",
    key: "secret",
  });
  const parsed = parseTenantDesktopSharePath("/desktop-share/tvm/tenant-demo-vm/d-abc123/share-1");
  const desktopUrl = rewriteTenantDesktopUrl(
    "/desktop/gmail/vnc.html?autoconnect=1&resize=scale&path=desktop/gmail/websockify",
    "tenant-demo-vm",
  );

  assert.equal(template, "https://app.example.test/desktop-share/tvm/tenant-demo-vm/{subdomain}/{shareId}?key={key}");
  assert.equal(sharePath, "/desktop-share/tvm/tenant-demo-vm/d-abc123/share-1?key=secret");
  assert.deepEqual(parsed, { tenantVmId: "tenant-demo-vm", subdomain: "d-abc123", shareId: "share-1" });
  assert.equal(
    desktopUrl,
    "/tenant-vms/tenant-demo-vm/desktop/gmail/vnc.html?autoconnect=1&resize=scale&path=tenant-vms%2Ftenant-demo-vm%2Fdesktop%2Fgmail%2Fwebsockify",
  );
});

test("desktop shares reject wrong path subdomains and link keys", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-reject-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  };
  const principal = userPrincipal({ id: "alice", role: "user" });

  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const { shareId, key } = urlParts(created.url);

  await assert.rejects(
    () => openDesktopShare({ shareId, key: "wrong-key", subdomain: created.subdomain, env }),
    /desktop_share_key_invalid/,
  );
  await assert.rejects(
    () => openDesktopShare({ shareId, key, subdomain: "wrong-subdomain", env }),
    /desktop_share_subdomain_invalid/,
  );
});

test("expired desktop shares expose renewal hints only with the original link key", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-share-renewal-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  };
  const principal = userPrincipal({ id: "alice", role: "user" });
  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const { shareId, key } = urlParts(created.url);
  const statePath = path.join(home, "secrets", "desktop-shares.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.desktopShares[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    () => openDesktopShare({ shareId, key, subdomain: created.subdomain, env }),
    /desktop_share_expired/,
  );
  const renewal = await desktopShareRenewalHint({ shareId, key, subdomain: created.subdomain, env });
  const wrongKey = await desktopShareRenewalHint({ shareId, key: "wrong-key", subdomain: created.subdomain, env });

  assert.equal(renewal.desktopSlug, "linkedin");
  assert.equal(renewal.renewCommand, "orkestr desktop share linkedin");
  assert.match(renewal.message, /desktop link expired/i);
  assert.equal(wrongKey, null);
});

test("thread router leaves desktop link requests for the agent skill", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-desktop-skill-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({
    id: "thread-desktop-skill",
    name: "Desktop Skill",
    cwd: home,
    ownerUserId: "alice",
  }, env);
  const request = await enqueueThreadInput(thread.id, {
    text: "/desktop",
    source: "whatsapp",
    connector: "whatsapp",
  }, env);

  assert.equal(await completeThreadSecurityApproveCommand(thread, request, env), null);
});
