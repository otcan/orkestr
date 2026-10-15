import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupLocalWhatsAppChromeLocks } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { chromeLockFromOtherHost, chromeLockHost, retireLoggedOutSession } from "../packages/connectors/src/whatsapp-session-recovery.js";

// A recreated Docker container has a new hostname but reuses low pids, so a
// lock from the old container can point at a live, unrelated process.
test("a Chrome lock from another host is stale even when its pid is alive here", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-lock-host-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "account-1", ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "account-1:wa-one" };
  const oldContainer = path.join(home, "whatsapp-bridge", "sessions", "session-wa-one");
  const thisHost = path.join(home, "whatsapp-bridge", "sessions", "session-live");
  await fs.mkdir(oldContainer, { recursive: true });
  await fs.mkdir(thisHost, { recursive: true });
  await fs.symlink(`f9707953bf52-${process.pid}`, path.join(oldContainer, "SingletonLock"));
  await fs.writeFile(path.join(oldContainer, "SingletonCookie"), "x");
  await fs.symlink(`${os.hostname()}-${process.pid}`, path.join(thisHost, "SingletonLock"));

  assert.equal(await chromeLockHost(path.join(oldContainer, "SingletonLock")), "f9707953bf52");
  assert.equal(chromeLockFromOtherHost("f9707953bf52"), true);
  assert.equal(chromeLockFromOtherHost(os.hostname()), false);
  assert.equal(chromeLockFromOtherHost(""), false);

  const result = await cleanupLocalWhatsAppChromeLocks("account-1", env);
  await assert.rejects(fs.lstat(path.join(oldContainer, "SingletonLock")), "the old container's lock is moved aside");
  await assert.rejects(fs.lstat(path.join(oldContainer, "SingletonCookie")));
  assert.ok((await fs.lstat(path.join(thisHost, "SingletonLock"))).isSymbolicLink(), "a live lock on this host stays");
  assert.equal(result.moved.length, 2);
});

test("a logged-out WhatsApp session is moved aside once, keeping the last copy", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-retire-"));
  const dir = path.join(home, "session-wa-one");
  assert.equal(await retireLoggedOutSession(dir), "", "nothing to do without a session");
  await fs.mkdir(path.join(dir, "Default"), { recursive: true });
  await fs.writeFile(path.join(dir, "Default", "marker"), "first");
  assert.equal(await retireLoggedOutSession(dir), `${dir}.logged-out`);
  await assert.rejects(fs.access(dir));
  await fs.mkdir(path.join(dir, "Default"), { recursive: true });
  await fs.writeFile(path.join(dir, "Default", "marker"), "second");
  await retireLoggedOutSession(dir);
  assert.equal(await fs.readFile(path.join(`${dir}.logged-out`, "Default", "marker"), "utf8"), "second");
});

test("Connect after a verified logout starts a fresh pairing", async () => {
  const bridge = await fs.readFile("packages/connectors/src/whatsapp-local-bridge.js", "utf8");
  assert.match(bridge, /previousState\.verifiedLogoutAt \|\| previousState\.state === "auth_failure"[\s\S]{0,200}retireLoggedOutSession/);
  assert.match(bridge, /state: "qr_needed",[\s\S]{0,200}verifiedLogoutAt: null/, "a new QR clears the logout mark");
  assert.match(bridge, /const qrAvailable = !verifiedLogoutIsNewer && /, "no QR is offered after a verified logout");
  assert.match(bridge, /await writeQr\(normalized, qr[^\n]*\n[\s\S]{0,250}if \(!ownsRuntime\(\)\) return;\n\s*if \(\(accountStates\.get\(normalized\) \|\| \{\}\)\.state === "auth_failure"\) \{[\s\S]{0,160}clearQr\(normalized, env\)[\s\S]{0,80}return;\n\s*\}\n\s*setAccountState\(normalized, \{\n\s*state: "qr_needed"/, "a late QR never overrides an auth failure");
});

test("deleting a chat-level registry binding retires the record, not just its thread", async () => {
  const { createThread } = await import("../packages/core/src/threads.js");
  const { upsertWhatsAppBindingRecord, readWhatsAppBindingRecords } = await import("../packages/connectors/src/whatsapp-binding-registry.js");
  const { retireWhatsAppThreadBinding } = await import("../packages/connectors/src/whatsapp-account-bindings.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-retire-record-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  await createThread({ id: "old-e2e", name: "old-e2e", ownerUserId: "admin", executorId: "noop",
    binding: { connector: "whatsapp", chatId: "51300000000000@lid", enabled: false, retired: true } }, env);
  // Shape seen in production: chat level, a threadId, no source field.
  await upsertWhatsAppBindingRecord({ id: "chat:51300000000000@lid:whatsapp", level: "chat", threadId: "old-e2e", ownerUserId: "admin",
    chatId: "51300000000000@lid", accountId: "sender", responderConnectorAccountId: "sender", enabled: true, routeEligible: true }, env);
  await retireWhatsAppThreadBinding("chat:51300000000000@lid:whatsapp", env);
  const record = (await readWhatsAppBindingRecords(env)).find((item) => item.id === "chat:51300000000000@lid:whatsapp");
  assert.equal(record.enabled, false);
  assert.equal(record.routeEligible, false);
  assert.equal(record.retired, true);
});
