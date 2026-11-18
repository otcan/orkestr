// list_incoming_whatsapp_messages through the bridge grant checks, over a
// synthetic scoped-relay journal (same schema as the live transport) and a
// fake coordinator bridge (same routes and paging as whatsapp-scoped-coordinator).
// All numbers, chats and texts are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createThread, updateThread } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { callThreadBridgeTool } from "../packages/core/src/thread-bridge-mcp.js";
import { bridgeWhatsAppIncoming } from "../packages/core/src/thread-bridge-whatsapp.js";
import { clearCoordinatorChatCache } from "../packages/core/src/whatsapp-incoming-readers.js";
import { chatRef as keyedChatRef, maskedNumber } from "../packages/core/src/whatsapp-incoming-sources.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

const principal = { kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a", issuer: "orkestr", authMethod: "orkestr-oauth",
  scopes: ["threads:read"] };
const grant = { id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "orkestr", authMethod: "orkestr-oauth", enabled: true,
  expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all", message: "all", whatsappRead: ["orkestr", "german"] };
const TOKEN = "synthetic-coordinator-token-value";
const OWNER_LID = "100000000000001@lid";
const BOT = "900000000000009@c.us";
const BOT_LID = "900000000000019@lid";
const PEER = "491700000001@c.us";
const PEER_LID = "200000000000002@lid";
const STRANGER = "491700000003@c.us";
const GROUP_A = "120363000000000001@g.us";
const GROUP_OTHER_OWNER = "120363000000000002@g.us";
const GROUP_UNBOUND = "120363000000000003@g.us";
const REF_KEY = "a".repeat(64);
const chatRef = (account, raw) => keyedChatRef(REF_KEY, account, raw);
const minute = 60_000;
const hour = 60 * minute;

async function fixture(t, { grantOverride = {}, sources = null } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bridge-whatsapp-"));
  const journal = path.join(home, "transport.sqlite");
  const tokenFile = path.join(home, "coordinator.token");
  const sourcesFile = path.join(home, "whatsapp-incoming-sources.json");
  const grants = path.join(home, "thread-bridge-grants.json");
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_WHATSAPP_INCOMING_SOURCES: sourcesFile };
  await fs.writeFile(grants, JSON.stringify([{ ...grant, ...grantOverride }]));
  await fs.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await createUser({ id: "owner-a" }, env);
  await createUser({ id: "owner-b" }, env);
  await createThread({ id: "thread-a", ownerUserId: "owner-a", name: "Sales", binding: { connector: "whatsapp", chatId: GROUP_A, displayName: "Sales group",
    additionalParticipantLabels: { [PEER]: "Peer One", [PEER_LID]: "Peer One" } } }, env);
  await createThread({ id: "thread-b", ownerUserId: "owner-b", name: "Other owner", binding: { connector: "whatsapp", chatId: GROUP_OTHER_OWNER } }, env);
  // Like the live relay: a WAL journal its writer keeps open.
  const writer = new DatabaseSync(journal);
  writer.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE group_input_author(id TEXT PRIMARY KEY,proof TEXT NOT NULL);
    CREATE TABLE group_input_media(id TEXT PRIMARY KEY,path TEXT NOT NULL,filename TEXT,mimetype TEXT,size INTEGER);`);
  let open = true;
  const closeWriter = () => { if (open) writer.close(); open = false; };
  const writeSources = (accounts, refKey = REF_KEY) => fs.writeFile(sourcesFile, JSON.stringify({ format: "orkestr-whatsapp-incoming-sources-v1", refKey, accounts }), { mode: 0o600 });
  t.after(async () => { closeWriter(); clearCoordinatorChatCache(); await closeThreadMessageRegistryCache(); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { home, env, journal, tokenFile, sourcesFile, grants, writeSources, closeWriter };
}

const orkestrSource = (f, extra = {}) => ({ account: "orkestr", label: "Orkestr number", ownerUserId: "owner-a", kind: "scoped_relay_journal", journalPath: f.journal, ...extra });
const germanSource = (f, baseUrl, extra = {}) => ({ account: "german", label: "German personal number", ownerUserId: "owner-a", kind: "coordinator_bridge",
  baseUrl, tokenFile: f.tokenFile, ownerApprovedAt: "2026-11-18T09:27:00Z", assistantAuthorIds: [BOT, BOT_LID], ...extra });

// One journal input: owner inputs have no author proof, participant inputs do.
function journalInput(file, { chat = GROUP_A, key, author = OWNER_LID, phone = null, at, body = "hello", proof = undefined, mimetype = null, fromMe = false }) {
  const db = new DatabaseSync(file);
  const id = `${fromMe ? "true" : "false"}_${chat}_${key}_${author}`;
  db.prepare("INSERT INTO group_input VALUES(?,?,?,?)").run(id, chat, body, new Date(at).toISOString());
  const evidence = proof === undefined && phone ? { version: "1", inputId: id, chatId: chat, threadId: "thread-a", authorId: author, phoneId: phone, createdAt: new Date(at).toISOString() } : proof;
  if (evidence) db.prepare("INSERT INTO group_input_author VALUES(?,?)").run(id, JSON.stringify(typeof evidence === "function" ? evidence(id) : evidence));
  if (mimetype) db.prepare("INSERT INTO group_input_media VALUES(?,?,?,?,?)").run(id, `/synthetic/media/${key}.jpg`, "photo.jpg", mimetype, 10);
  db.close();
  return id;
}

const call = (input, env, who = principal) => callThreadBridgeTool("list_incoming_whatsapp_messages", input, who, env);
const ok = (result) => { assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent; };
const errorOf = (result) => { assert.equal(result.isError, true); return JSON.parse(result.content[0].text).error; };

test("only a grant that observes all threads and consented to that account may read it; nothing else widens access", async (t) => {
  const f = await fixture(t);
  await f.writeSources([orkestrSource(f)]);
  assert.equal(ok(await call({ account: "orkestr" }, f.env)).available, true);
  const cases = [
    [{ whatsappRead: undefined }, "orkestr", "bridge_whatsapp_not_granted"],
    [{ whatsappRead: "all" }, "orkestr", "bridge_whatsapp_not_granted"],
    [{ whatsappRead: ["orkestr"] }, "german", "bridge_whatsapp_not_granted"],
    [{ observe: ["thread-a"] }, "orkestr", "bridge_whatsapp_not_granted"],
    [{ enabled: false }, "orkestr", "bridge_grant_revoked"],
    [{ ownerUserId: "owner-b" }, "orkestr", "bridge_grant_revoked"],
  ];
  for (const [override, account, expected] of cases) {
    await fs.writeFile(f.grants, JSON.stringify([{ ...grant, ...override }]));
    assert.equal(errorOf(await call({ account }, f.env)), expected, JSON.stringify(override));
  }
  await fs.writeFile(f.grants, JSON.stringify([grant]));
  assert.equal(errorOf(await call({ account: "orkestr" }, f.env, { ...principal, scopes: ["threads:comment", "threads:message"] })), "insufficient_scope");
  assert.equal(errorOf(await call({ account: "orkestr" }, { ...f.env, ORKESTR_THREAD_BRIDGE_ENABLED: "0" })), "thread_bridge_disabled");
  assert.equal(errorOf(await call({ account: "personal" }, f.env)), "invalid_arguments");
  assert.equal(errorOf(await call({ account: "orkestr", limit: 51 }, f.env)), "invalid_arguments");
  assert.equal(errorOf(await call({ account: "orkestr", chat: GROUP_A }, f.env)), "invalid_arguments", "raw chat ids are not accepted");
});

test("an account that is granted but not enrolled, or an unprotected enrollment, is not connected, never empty", async (t) => {
  const f = await fixture(t);
  const none = ok(await call({ account: "german" }, f.env));
  assert.equal(none.available, false);
  assert.equal(none.reason, "not_enrolled");
  assert.deepEqual(none.accounts.map((entry) => [entry.account, entry.state]), [["orkestr", "not_connected"], ["german", "not_connected"]]);
  await f.writeSources([orkestrSource(f)]);
  await fs.chmod(f.sourcesFile, 0o666);
  assert.equal(ok(await call({ account: "orkestr" }, f.env)).reason, "not_enrolled", "a group/world-writable enrollment is ignored");
  await fs.chmod(f.sourcesFile, 0o600);
  await f.writeSources([orkestrSource(f, { ownerUserId: "owner-b" })]);
  assert.equal(ok(await call({ account: "orkestr" }, f.env)).reason, "not_enrolled", "another owner's enrollment is not this owner's");
  await f.writeSources([orkestrSource(f), orkestrSource(f, { label: "duplicate" })]);
  assert.equal(ok(await call({ account: "orkestr" }, f.env)).reason, "not_enrolled", "an ambiguous enrollment enrolls nothing");
  await f.writeSources([orkestrSource(f, { journalPath: path.join(f.home, "missing.sqlite") })]);
  const missing = ok(await call({ account: "orkestr" }, f.env));
  assert.deepEqual([missing.available, missing.reason, missing.messages.length], [false, "journal_missing", 0]);
  // A journal nobody records into is reported, and reading never creates files next to it.
  await f.writeSources([orkestrSource(f)]);
  f.closeWriter();
  const before = (await fs.readdir(f.home)).sort();
  const stopped = ok(await call({ account: "orkestr" }, f.env));
  assert.deepEqual([stopped.available, stopped.reason], [false, "journal_not_recording"]);
  assert.deepEqual((await fs.readdir(f.home)).sort(), before);
  await f.writeSources([germanSource(f, "https://example.com/")]);
  assert.equal(ok(await call({ account: "german" }, f.env)).reason, "not_enrolled", "the bridge token is only ever sent to a loopback origin");
  await f.writeSources([germanSource(f, "http://localhost:9/")]);
  assert.equal(ok(await call({ account: "german" }, f.env)).reason, "not_enrolled", "not even to a name that resolves elsewhere");
  await f.writeSources([orkestrSource(f)], null);
  assert.equal(ok(await call({ account: "orkestr" }, f.env)).reason, "not_enrolled", "references need the file's key");
});

test("orkestr: only listed participants' admitted inputs from groups bound to the owner's observed threads, masked and paged", async (t) => {
  const f = await fixture(t);
  await f.writeSources([orkestrSource(f, { ownerAuthorIds: [OWNER_LID] })]);
  const now = Date.now();
  journalInput(f.journal, { key: "AAAAAA0001", at: now - 50 * minute, body: "owner's own input" });
  journalInput(f.journal, { key: "AAAAAA0002", author: BOT_LID, at: now - 49 * minute, body: "bot", fromMe: true });
  journalInput(f.journal, { key: "AAAAAA0003", author: PEER_LID, phone: PEER, at: now - 40 * minute, body: "first from peer" });
  journalInput(f.journal, { key: "AAAAAA0004", author: PEER_LID, phone: PEER, at: now - 30 * minute, body: "caption", mimetype: "image/jpeg" });
  journalInput(f.journal, { key: "AAAAAA0005", author: PEER_LID, phone: PEER, at: now - 20 * minute, body: "[WhatsApp attachment skipped: unsupported media type ptt]" });
  journalInput(f.journal, { chat: GROUP_OTHER_OWNER, key: "BBBBBB0001", author: PEER_LID, phone: PEER, at: now - 10 * minute, body: "other owner's group",
    proof: (id) => ({ version: "1", inputId: id, chatId: GROUP_OTHER_OWNER, threadId: "thread-b", authorId: PEER_LID, phoneId: PEER }) });
  journalInput(f.journal, { chat: GROUP_UNBOUND, key: "CCCCCC0001", author: PEER_LID, phone: PEER, at: now - 9 * minute, body: "unbound group",
    proof: (id) => ({ version: "1", inputId: id, chatId: GROUP_UNBOUND, threadId: "thread-a", authorId: PEER_LID, phoneId: PEER }) });
  journalInput(f.journal, { key: "AAAAAA0006", author: PEER_LID, phone: PEER, at: now - 8 * minute, body: "proof for another thread",
    proof: (id) => ({ version: "1", inputId: id, chatId: GROUP_A, threadId: "thread-b", authorId: PEER_LID, phoneId: PEER }) });
  journalInput(f.journal, { key: "AAAAAA0007", author: OWNER_LID, phone: "491700000099@c.us", at: now - 7 * minute, body: "owner via participant proof" });
  journalInput(f.journal, { key: "AAAAAA0008", author: PEER_LID, phone: PEER, at: now - 8 * 24 * hour, body: "older than the default week" });

  const snapshot = async () => Promise.all(["", "-wal"].map((suffix) => fs.readFile(`${f.journal}${suffix}`)));
  const contentBefore = await snapshot();
  const report = ok(await call({ account: "orkestr" }, f.env));
  assert.deepEqual(await snapshot(), contentBefore, "the journal is only read");
  assert.equal(report.format, "orkestr-whatsapp-incoming-v1");
  assert.equal(report.available, true);
  assert.equal(report.timezone, "Europe/Berlin");
  assert.deepEqual(report.messages.map((message) => message.text), [null, "caption", "first from peer"]);
  assert.deepEqual(report.messages.map((message) => message.type), ["ptt", "image", "text"]);
  const [, image, first] = report.messages;
  assert.deepEqual(first.chat, { id: chatRef("orkestr", GROUP_A), name: "Sales group", kind: "group", threadId: "thread-a" });
  assert.deepEqual(first.sender, { name: "Peer One", number: "+49…01", ref: first.sender.ref });
  assert.match(first.sender.ref, /^ws-[0-9a-f]{20}$/);
  // References are keyed: another key gives other references, and none is a plain hash of the raw id.
  const crypto = await import("node:crypto");
  assert.notEqual(first.chat.id, `wa-${crypto.createHash("sha256").update(["orkestr-wa-chat-v1", "orkestr", GROUP_A].join("\0")).digest("hex").slice(0, 20)}`);
  await f.writeSources([orkestrSource(f, { ownerAuthorIds: [OWNER_LID] })], "b".repeat(64));
  const rekeyed = ok(await call({ account: "orkestr" }, f.env)).messages.at(-1);
  assert.notEqual(rekeyed.chat.id, first.chat.id);
  assert.notEqual(rekeyed.sender.ref, first.sender.ref);
  await f.writeSources([orkestrSource(f, { ownerAuthorIds: [OWNER_LID] })]);
  assert.equal(first.id, "AAAAAA0003");
  assert.equal(first.receivedAt.utc, new Date(now - 40 * minute).toISOString());
  assert.match(first.receivedAt.berlin, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
  assert.equal(image.type, "image");
  assert.equal(report.hasMore, false);
  assert.equal(report.nextCursor, null);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.accounts[0].state, "available");
  assert.equal(report.accounts[0].stale, false);
  assert.ok(report.limits.length > 0);

  const older = ok(await call({ account: "orkestr", since: new Date(now - 9 * 24 * hour).toISOString() }, f.env));
  assert.equal(older.messages.at(-1).text, "older than the default week");

  const text = JSON.stringify(report);
  for (const leak of ["491700000001", "200000000000002", "120363000000000001", GROUP_OTHER_OWNER, "other owner's group", "unbound group", "owner's own input",
    "proof for another thread", "owner via participant proof", "bot", f.journal, f.home, "/synthetic/media", "photo.jpg", "owner-a", "grant-a", "agent-a"]) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }

  // A thread that leaves the owner's grant takes its group with it.
  await updateThread("thread-a", { ownerUserId: "owner-b" }, f.env);
  assert.deepEqual(ok(await call({ account: "orkestr" }, f.env)).messages, []);
});

test("orkestr: cursor pages are disjoint and complete, including same-second inputs, and are bound to account, chat and since", async (t) => {
  const f = await fixture(t);
  await f.writeSources([orkestrSource(f)]);
  const base = Math.floor(Date.now() / 1000) * 1000 - hour;
  const keys = [];
  for (let index = 0; index < 7; index += 1) {
    const key = `DDDDDD000${index}`;
    keys.push(key);
    journalInput(f.journal, { key, author: PEER_LID, phone: PEER, at: index < 3 ? base : base + index * minute, body: `m${index}` });
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const report = ok(await call({ account: "orkestr", limit: 2, ...(cursor ? { cursor } : {}) }, f.env));
    seen.push(...report.messages.map((message) => message.id));
    cursor = report.nextCursor;
    assert.equal(report.hasMore, Boolean(cursor));
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 4);
  assert.deepEqual([...seen].sort(), [...keys].sort());
  assert.equal(new Set(seen).size, keys.length);

  const first = ok(await call({ account: "orkestr", limit: 2 }, f.env));
  const ref = chatRef("orkestr", GROUP_A);
  assert.equal(errorOf(await call({ account: "orkestr", cursor: first.nextCursor, chat: ref }, f.env)), "whatsapp_cursor_mismatch");
  assert.equal(errorOf(await call({ account: "orkestr", cursor: first.nextCursor, since: new Date(base - day()).toISOString() }, f.env)), "whatsapp_cursor_mismatch");
  assert.equal(errorOf(await call({ account: "german", cursor: first.nextCursor }, f.env)), "whatsapp_cursor_mismatch");
  assert.equal(errorOf(await call({ account: "orkestr", cursor: "not-a-cursor!" }, f.env)), "whatsapp_cursor_invalid");
  assert.equal(errorOf(await call({ account: "orkestr", cursor: Buffer.from(JSON.stringify({ v: 1, a: "orkestr", c: null, s: 0, t: 1, k: `wa-${"0".repeat(20)}:${GROUP_A}` })).toString("base64url") }, f.env)), "whatsapp_cursor_invalid");
  assert.equal(errorOf(await call({ account: "orkestr", since: "2026-11-18 10:00" }, f.env)), "whatsapp_since_invalid", "since needs an explicit offset");
  assert.equal(errorOf(await call({ account: "orkestr", since: new Date(Date.now() + day()).toISOString() }, f.env)), "whatsapp_since_invalid");
  assert.ok(!Buffer.from(first.nextCursor, "base64url").toString("utf8").includes("491700000001"), "the cursor carries no raw id");

  const filtered = ok(await call({ account: "orkestr", chat: ref, limit: 50 }, f.env));
  assert.equal(filtered.messages.length, 7);
  assert.equal(errorOf(await call({ account: "orkestr", chat: chatRef("orkestr", GROUP_OTHER_OWNER) }, f.env)), "whatsapp_chat_not_found");
});

function day() { return 24 * hour; }

// ---- german: a fake coordinator bridge with the real routes and paging ----------

function fakeBridge(t, { chats, health = { ok: true, ready: true, identityMatches: true, markSeen: false }, onRequest = null } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://bridge.local");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || "" });
    if (onRequest) await onRequest(url);
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { ok: false, error: "coordinator_unauthorized" });
    if (req.method !== "GET") return send(405, { ok: false, error: "coordinator_route_unknown" });
    if (url.pathname === "/coordinator/health") return send(200, health);
    if (url.pathname === "/coordinator/chats") {
      const list = [...chats].sort((left, right) => right.messages.at(-1).t - left.messages.at(-1).t);
      return send(200, { ok: true, source: "chats", chats: list.slice(0, Number(url.searchParams.get("limit"))).map((chat) => ({
        chatId: chat.id, label: chat.name, isGroup: chat.id.endsWith("@g.us"), unreadCount: 0,
        lastMessageAt: chat.noTime ? null : new Date(chat.messages.at(-1).t).toISOString(), lastFromThem: !chat.messages.at(-1).fromMe })), hasMore: false, nextCursor: null, total: list.length });
    }
    const match = /^\/coordinator\/chats\/([^/]+)\/messages$/.exec(url.pathname);
    if (match) {
      const chat = chats.find((entry) => entry.id === decodeURIComponent(match[1]));
      const ordered = [...chat.messages].reverse();
      const before = url.searchParams.get("before");
      const index = before ? ordered.findIndex((message) => message.id === before) : -1;
      if (before && index < 0) return send(400, { ok: false, error: "scoped_worker_invalid_cursor" });
      const older = before ? ordered.slice(index + 1) : ordered;
      const size = Number(url.searchParams.get("limit"));
      const pageMessages = older.slice(0, size);
      const hasMore = older.length > size;
      return send(200, { ok: true, chatId: chat.id, name: chat.name, hasMore, nextCursor: hasMore ? pageMessages.at(-1).id : null,
        messages: pageMessages.map((message) => ({ id: message.id, fromMe: message.fromMe, author: message.author, timestamp: new Date(message.t).toISOString(),
          type: message.type || "chat", body: message.body, hasMedia: Boolean(message.hasMedia), hasQuotedMsg: false, quotedMessageId: null, ack: 1 })) });
    }
    return send(404, { ok: false, error: "coordinator_route_unknown" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    t.after(() => new Promise((done) => server.close(done)));
    resolve({ baseUrl: `http://127.0.0.1:${server.address().port}/`, requests });
  }));
}

let counter = 0;
const wa = (chat, { t, author = null, fromMe = false, type = "chat", body = "", hasMedia = false }) => {
  counter += 1;
  const key = `3EB0${String(counter).padStart(8, "0")}`;
  return { id: `${fromMe}_${chat}_${key}${chat.endsWith("@g.us") && author ? `_${author}` : ""}`, key, t, author: chat.endsWith("@g.us") ? author : (fromMe ? null : chat), fromMe, type, body, hasMedia };
};

test("german: incoming only, from the live bridge's GET routes, with masked senders and no raw ids", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const direct = { id: "491700000005@c.us", name: "Anna Example", messages: [] };
  const group = { id: GROUP_UNBOUND, name: "Family", messages: [] };
  direct.messages.push(wa(direct.id, { t: now - 30 * minute, body: "hi Can" }), wa(direct.id, { t: now - 29 * minute, fromMe: true, body: "my own reply" }),
    wa(direct.id, { t: now - 28 * minute, type: "call_log" }), wa(direct.id, { t: now - 27 * minute, type: "image", body: "/9j/4AAQSkZJRgABAQ".padEnd(400, "A"), hasMedia: true }));
  group.messages.push(wa(group.id, { t: now - 20 * minute, author: PEER_LID, body: "group hello" }), wa(group.id, { t: now - 19 * minute, author: BOT_LID, body: "assistant reply" }),
    wa(group.id, { t: now - 18 * minute, author: STRANGER, type: "ptt", hasMedia: true }), wa(group.id, { t: now - 17 * minute, type: "gp2" }),
    wa(group.id, { t: now - 16 * minute, author: OWNER_LID, fromMe: true, body: "owner in group" }));
  const bridge = await fakeBridge(t, { chats: [direct, group] });
  await f.writeSources([orkestrSource(f), germanSource(f, bridge.baseUrl)]);

  const report = ok(await call({ account: "german" }, f.env));
  assert.equal(report.available, true);
  assert.deepEqual(report.messages.map((message) => [message.type, message.text]), [["voice", null], ["text", "group hello"], ["image", null], ["text", "hi Can"]]);
  const [voice, hello, , hi] = report.messages;
  assert.deepEqual(voice.sender, { name: null, number: maskedNumber(STRANGER), ref: voice.sender.ref });
  assert.deepEqual(hello.sender.name, null);
  assert.equal(hello.sender.number, null, "a LID has no number to show");
  assert.deepEqual(hello.chat, { id: chatRef("german", GROUP_UNBOUND), name: "Family", kind: "group" });
  assert.deepEqual(hi.chat, { id: chatRef("german", direct.id), name: "Anna Example", kind: "direct" });
  assert.deepEqual(hi.sender, { name: "Anna Example", number: "+49…05", ref: hi.sender.ref });
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.chatsScanned, 2);
  assert.deepEqual(report.accounts.map((entry) => [entry.account, entry.state]), [["orkestr", "available"], ["german", "available"]]);

  for (const request of bridge.requests) {
    assert.equal(request.method, "GET");
    assert.match(request.path, /^\/coordinator\/(health|chats|chats\/[^/]+\/messages)$/);
    assert.equal(request.auth, `Bearer ${TOKEN}`);
  }
  const text = JSON.stringify(report);
  for (const leak of [TOKEN, "491700000005", "491700000003", "120363000000000003", "200000000000002", "assistant reply", "my own reply", "owner in group", f.tokenFile, f.home, "/9j/"]) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }

  const one = ok(await call({ account: "german", chat: chatRef("german", direct.id) }, f.env));
  assert.deepEqual(one.messages.map((message) => message.text), [null, "hi Can"]);
  assert.equal(errorOf(await call({ account: "german", chat: chatRef("german", "491799999999@c.us") }, f.env)), "whatsapp_chat_not_found");
});

test("german: busy chats are walked back page by page; pages across chats are disjoint, gap-free, and say how far they reach", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const busy = { id: "120363000000000010@g.us", name: "Busy", messages: [] };
  for (let index = 0; index < 400; index += 1) busy.messages.push(wa(busy.id, { t: now - (400 - index) * minute, author: PEER_LID, body: `busy ${index}` }));
  const quiet = { id: "491700000006@c.us", name: "Quiet", messages: [] };
  for (let index = 0; index < 5; index += 1) quiet.messages.push(wa(quiet.id, { t: now - (300 - index * 60) * minute - 30_000, body: `quiet ${index}` }));
  const bridge = await fakeBridge(t, { chats: [busy, quiet] });
  await f.writeSources([germanSource(f, bridge.baseUrl)]);

  // 3 pages x 50 of the busy chat are read: only what is newer than its oldest read message is answered.
  const seen = [];
  let cursor;
  let first;
  do {
    const report = ok(await call({ account: "german", limit: 40, ...(cursor ? { cursor } : {}) }, f.env));
    first ||= report;
    seen.push(...report.messages.map((message) => message.text));
    cursor = report.nextCursor;
  } while (cursor);
  const cutoff = Date.parse(first.coverage.completeAfter);
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.truncatedChats.length, 1);
  assert.equal(first.coverage.truncatedChats[0].chat.name, "Busy");
  assert.equal(cutoff, busy.messages[400 - 150].t, "the oldest busy message read");
  const expected = [...busy.messages, ...quiet.messages].filter((message) => message.t > cutoff).map((message) => message.body);
  assert.deepEqual([...seen].sort(), [...expected].sort());
  assert.equal(new Set(seen).size, seen.length, "no message twice");

  // One chat: the walk goes further back and pages to its start in range.
  const chat = chatRef("german", busy.id);
  const all = [];
  cursor = undefined;
  do {
    const report = ok(await call({ account: "german", chat, limit: 50, ...(cursor ? { cursor } : {}) }, f.env));
    all.push(...report.messages.map((message) => message.text));
    cursor = report.nextCursor;
  } while (cursor);
  assert.equal(all.length, 400);
  assert.equal(new Set(all).size, 400);
});

test("german: number-like names are masked, chats without an activity time are read, and a listing whose window moved says so", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const unnamed = { id: "491700000011@c.us", name: "+49 170 0000011", messages: [wa("491700000011@c.us", { t: now - 5 * minute, body: "from an unsaved number" })] };
  const timeless = { id: "491700000012@c.us", name: "No time", noTime: true, messages: [wa("491700000012@c.us", { t: now - 6 * minute, body: "chat without a time" })] };
  const busy = { id: "120363000000000013@g.us", name: "Busy", messages: [] };
  for (let index = 0; index < 200; index += 1) busy.messages.push(wa(busy.id, { t: now - (300 - index) * minute, author: PEER_LID, body: `b${index}` }));
  const bridge = await fakeBridge(t, { chats: [unnamed, timeless, busy] });
  await f.writeSources([germanSource(f, bridge.baseUrl)]);

  const first = ok(await call({ account: "german", limit: 5 }, f.env));
  assert.deepEqual(first.messages.slice(0, 2).map((message) => message.text), ["from an unsaved number", "chat without a time"]);
  const unsaved = first.messages[0];
  assert.deepEqual([unsaved.chat.name, unsaved.sender.name, unsaved.sender.number], ["+49…11", "+49…11", "+49…11"]);
  assert.ok(!JSON.stringify(first).includes("0000011"), "the formatted number in the name is masked");
  assert.equal(first.coverage.truncatedChats[0].chat.name, "Busy");

  // New messages push the busy chat's 150-message window: page 2 cannot reach this listing's older messages.
  for (let index = 0; index < 10; index += 1) busy.messages.push(wa(busy.id, { t: now - (9 - index) * 1000, author: PEER_LID, body: `new ${index}` }));
  assert.equal(errorOf(await call({ account: "german", limit: 5, cursor: first.nextCursor }, f.env)), "whatsapp_cursor_expired");
  const fresh = ok(await call({ account: "german", limit: 5 }, f.env));
  assert.equal(fresh.messages[0].text, "new 9");
});

test("german: a bridge that is not ready, marks seen, lacks its credential or fails is unavailable with a reason", async (t) => {
  const f = await fixture(t);
  const chat = { id: "491700000007@c.us", name: "X", messages: [wa("491700000007@c.us", { t: Date.now() - minute, body: "x" })] };
  for (const [health, reason] of [[{ ok: true, ready: false, identityMatches: true, markSeen: false }, "bridge_not_ready"],
    [{ ok: true, ready: true, identityMatches: false, markSeen: false }, "identity_mismatch"],
    [{ ok: true, ready: true, identityMatches: true, markSeen: true }, "bridge_marks_seen"],
    [{ ok: false, error: "coordinator_failed" }, "bridge_error"]]) {
    const bridge = await fakeBridge(t, { chats: [chat], health });
    await f.writeSources([germanSource(f, bridge.baseUrl)]);
    const report = ok(await call({ account: "german" }, f.env));
    assert.deepEqual([report.available, report.reason, report.messages.length], [false, reason, 0]);
    assert.ok(bridge.requests.every((request) => request.path === "/coordinator/health"), "nothing is read from an unavailable bridge");
  }
  const bridge = await fakeBridge(t, { chats: [chat] });
  await f.writeSources([germanSource(f, bridge.baseUrl)]);
  await fs.chmod(f.tokenFile, 0o644);
  assert.equal(ok(await call({ account: "german" }, f.env)).reason, "credential_unavailable");
  await fs.chmod(f.tokenFile, 0o600);
  await f.writeSources([germanSource(f, "http://127.0.0.1:9/")]);
  assert.equal(ok(await call({ account: "german" }, f.env)).reason, "bridge_unreachable");
});

test("german: the grant is checked again after the live read; a grant narrowed meanwhile gets nothing", async (t) => {
  const f = await fixture(t);
  const chat = { id: "491700000008@c.us", name: "Y", messages: [wa("491700000008@c.us", { t: Date.now() - minute, body: "secret-ish" })] };
  const bridge = await fakeBridge(t, { chats: [chat], onRequest: async (url) => {
    if (url.pathname.endsWith("/messages")) await fs.writeFile(f.grants, JSON.stringify([{ ...grant, whatsappRead: ["orkestr"] }]));
  } });
  await f.writeSources([germanSource(f, bridge.baseUrl)]);
  await assert.rejects(bridgeWhatsAppIncoming(principal, { account: "german" }, f.env), /bridge_whatsapp_not_granted/);
});
