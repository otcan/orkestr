import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listConnectorInboxEvents, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import {
  decodeSocketMapFrames,
  encodeSocketMapFrame,
  ingestPostfixMailboxMessage,
  postfixSocketMapLookup,
} from "../packages/connectors/src/postfix-mailbox-adapter.js";
import { createMailbox, deleteMailboxForPrincipal, rotateMailboxForPrincipal } from "../packages/core/src/mailboxes.js";
import { adminPrincipal } from "../packages/core/src/principal.js";

async function fixture() {
  return {
    ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-postfix-mailbox-")),
    ORKESTR_MAILBOX_DOMAIN: "in.orkestr.de",
    ORKESTR_MAILBOX_MTA_ADAPTER: "postfix-socketmap",
    ORKESTR_MAILBOX_MTA_PROPAGATION: "live-socketmap",
    ORKESTR_MAILBOX_MTA_READY: "1",
  };
}

test.afterEach(() => resetConnectorInboxForTest());

test("Postfix socket map accepts only live Orkestr mailbox addresses", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ purpose: "alerts", suffix: "one", status: "active" }, env);
  assert.match(await postfixSocketMapLookup(`mailboxes ${mailbox.address}`, env), /^OK /);
  assert.equal(await postfixSocketMapLookup("mailboxes missing@in.orkestr.de", env), "NOTFOUND");

  const rotated = await rotateMailboxForPrincipal(mailbox.id, { suffix: "two" }, adminPrincipal(), env);
  assert.equal(await postfixSocketMapLookup(`mailboxes ${mailbox.address}`, env), "NOTFOUND");
  assert.match(await postfixSocketMapLookup(`mailboxes ${rotated.mailbox.address}`, env), /^OK /);

  await deleteMailboxForPrincipal(rotated.mailbox.id, {}, adminPrincipal(), env);
  assert.equal(await postfixSocketMapLookup(`mailboxes ${rotated.mailbox.address}`, env), "NOTFOUND");
});

test("Postfix ingest parses MIME and queues one scoped inbox event", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ purpose: "jobs", suffix: "mime", status: "active" }, env);
  const rawMime = Buffer.from([
    "From: Sender <sender@example.net>",
    `To: ${mailbox.address}`,
    "Message-ID: <postfix-e2e@example.net>",
    "Subject: Postfix adapter",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=sample",
    "",
    "--sample",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Scoped mailbox body",
    "--sample",
    "Content-Type: text/plain; name=proof.txt",
    "Content-Disposition: attachment; filename=proof.txt",
    "Content-Transfer-Encoding: base64",
    "",
    "cHJvb2Y=",
    "--sample--",
    "",
  ].join("\r\n"));

  const result = await ingestPostfixMailboxMessage({
    rawMime,
    recipient: mailbox.address,
    sender: "sender@example.net",
  }, env);
  assert.equal(result.action, "connector_inbox_queued");
  const events = await listConnectorInboxEvents({}, env);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.headers.messageId, "<postfix-e2e@example.net>");
  assert.equal(events[0].payload.provenance.ingestAdapter, "postfix-socketmap");
  assert.deepEqual(events[0].payload.attachments.map((item) => [item.filename, item.sizeBytes]), [["proof.txt", 5]]);
});

test("Postfix socket map netstrings decode incrementally", () => {
  const first = encodeSocketMapFrame("mailboxes one@in.orkestr.de");
  const second = encodeSocketMapFrame("mailboxes two@in.orkestr.de");
  const partial = Buffer.concat([first, second.subarray(0, 5)]);
  const decoded = decodeSocketMapFrames(partial);
  assert.deepEqual(decoded.frames, ["mailboxes one@in.orkestr.de"]);
  assert.deepEqual(decoded.remainder, second.subarray(0, 5));
  const completed = decodeSocketMapFrames(Buffer.concat([decoded.remainder, second.subarray(5)]));
  assert.deepEqual(completed.frames, ["mailboxes two@in.orkestr.de"]);
});

test("Postfix installer updates the main service and adapter environments", async () => {
  const script = await fs.readFile("scripts/install-postfix-mailbox.sh", "utf8");
  assert.match(script, /systemctl show -p EnvironmentFiles --value "\$main_unit"/);
  assert.match(script, /ui_env_file="\$\{ui_env_file:-\$env_file\}"/);
  assert.match(script, /upsert_env_file "\$env_file" "\$key" "\$value"/);
  assert.match(script, /upsert_env_file "\$ui_env_file" "\$key" "\$value"/);
});
