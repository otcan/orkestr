import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approveDesktopShareChallenge,
  authorizeDesktopShareHttpRequest,
  createDesktopShare,
  desktopShareStatus,
  openDesktopShare,
} from "../packages/core/src/desktop-shares.js";
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
  assert.match(key, /^[A-Za-z0-9_-]{30,}$/);
  assert.match(opened.attempt.challenge, /^desk-[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(opened.attempt.challenge, secondBrowser.attempt.challenge);
  assert.equal(pending.approved, false);
  assert.equal(approved.share.desktopSlug, "linkedin");
  assert.equal(ready.approved, true);
  assert.equal(ready.desktopUrl, "/desktop/linkedin/vnc.html?autoconnect=1&resize=scale");
  assert.equal(auth.principal.userId, "alice");
  await assert.rejects(() => authorizeDesktopShareHttpRequest({
    url: "/desktop/gmail/vnc.html",
    headers: { cookie: `orkestr_desktop_share=${encodeURIComponent(opened.cookie.value)}` },
  }, env), /desktop_share_slug_forbidden/);
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
