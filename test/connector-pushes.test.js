import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConnectorPromptPush,
  createConnectorPromptPushForPrincipal,
  runConnectorPromptPush,
} from "../packages/core/src/connector-pushes.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { visibleThreadMessages } from "../packages/core/src/thread-message-visibility.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createUser } from "../packages/core/src/users.js";
import { exchangeGmailCode } from "../packages/connectors/src/gmail.js";
import { runGmailPromptPush } from "../packages/connectors/src/gmail-prompt-push.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function gmailMessage({ id, subject, from, text }) {
  return {
    id,
    threadId: `thread-${id}`,
    snippet: `Snippet ${id}`,
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
        { name: "To", value: "me@example.com" },
        { name: "Date", value: "Wed, 03 Jun 2026 10:00:00 +0000" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from(text, "utf8").toString("base64url") },
        },
      ],
    },
  };
}

test("connector prompt pushes render source items and dedupe delivered messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-push-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "push-thread", name: "Push Thread" }, env);
  const push = await createConnectorPromptPush({
    connector: "gmail",
    threadId: "push-thread",
    prompt: "Summarize {{subject}} from {{from}}.",
    sourceConfig: { query: "from:recruiter newer_than:1d" },
    enabled: true,
  }, env);

  const first = await runConnectorPromptPush(push.id, [
    {
      id: "m1",
      subject: "Hiring update",
      from: "recruiter@example.com",
      text: "Can you talk tomorrow?",
    },
  ], env);
  const second = await runConnectorPromptPush(push.id, [
    {
      id: "m1",
      subject: "Hiring update",
      from: "recruiter@example.com",
      text: "Can you talk tomorrow?",
    },
  ], env);
  const messages = await listThreadMessages("push-thread", env);

  assert.equal(first.delivered.length, 1);
  assert.equal(second.delivered.length, 0);
  assert.equal(second.skipped[0].reason, "duplicate");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "connector_prompt_push");
  assert.equal(messages[0].connector, "gmail");
  assert.equal(messages[0].externalId, "m1");
  assert.equal(messages[0].visibility, "internal");
  assert.equal(visibleThreadMessages(messages).length, 0);
  assert.equal(messages[0].text, "Summarize Hiring update from recruiter@example.com.");
});

test("connector prompt push safety requires explicit enablement and caps batches", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-push-safety-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "safe-push-thread", name: "Safe Push Thread" }, env);
  const disabled = await createConnectorPromptPush({
    connector: "gmail",
    threadId: "safe-push-thread",
    prompt: "Handle {{subject}}",
    sourceConfig: { query: "newer_than:1d" },
    enabled: false,
  }, env);
  const capped = await createConnectorPromptPush({
    connector: "gmail",
    threadId: "safe-push-thread",
    prompt: "Handle {{subject}}",
    sourceConfig: { query: "newer_than:1d" },
    safety: { maxItemsPerRun: 20 },
    enabled: true,
  }, env);

  const disabledRun = await runConnectorPromptPush(disabled.id, [{ id: "disabled-1", subject: "No" }], env);
  const cappedRun = await runConnectorPromptPush(
    capped.id,
    Array.from({ length: 7 }, (_item, index) => ({ id: `m${index}`, subject: `Subject ${index}` })),
    env,
  );
  const messages = await listThreadMessages("safe-push-thread", env);

  assert.equal(disabledRun.delivered.length, 0);
  assert.equal(disabledRun.skipped[0].reason, "disabled");
  assert.equal(cappedRun.delivered.length, 5);
  assert.equal(cappedRun.skipped.filter((entry) => entry.reason === "batch_cap").length, 2);
  assert.equal(messages.length, 5);
});

test("connector prompt push safety requires a scoped source query by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-push-query-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "query-push-thread", name: "Query Push Thread" }, env);

  await assert.rejects(
    () => createConnectorPromptPush({
      connector: "gmail",
      threadId: "query-push-thread",
      prompt: "Handle all mail",
      enabled: true,
    }, env),
    /connector_prompt_push_query_required/,
  );
});

test("gmail prompt push collects messages through Gmail and queues prompts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-push-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "gmail-push-thread", name: "Gmail Push Thread" }, env);
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "gmail-push-access",
      refresh_token: "gmail-push-refresh",
      expires_in: 3600,
    }),
  );
  const push = await createConnectorPromptPush({
    connector: "gmail",
    threadId: "gmail-push-thread",
    prompt: "Classify this email: {{subject}}\n{{body}}",
    sourceConfig: { query: "from:alerts@example.com newer_than:1d", maxResults: 2 },
    enabled: true,
  }, env);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, "Bearer gmail-push-access");
    if (url.pathname.endsWith("/messages") && !url.pathname.match(/\/messages\/[^/]+$/)) {
      assert.equal(url.searchParams.get("q"), "from:alerts@example.com newer_than:1d");
      assert.equal(url.searchParams.get("maxResults"), "2");
      return jsonResponse({
        messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }],
        resultSizeEstimate: 2,
      });
    }
    if (url.pathname.endsWith("/messages/m1")) {
      return jsonResponse(gmailMessage({
        id: "m1",
        subject: "Alert one",
        from: "alerts@example.com",
        text: "First alert body",
      }));
    }
    if (url.pathname.endsWith("/messages/m2")) {
      return jsonResponse(gmailMessage({
        id: "m2",
        subject: "Alert two",
        from: "alerts@example.com",
        text: "Second alert body",
      }));
    }
    throw new Error(`unexpected Gmail fetch ${url.href}`);
  };

  const result = await runGmailPromptPush(push.id, env, fetchImpl);
  const duplicate = await runGmailPromptPush(push.id, env, fetchImpl);
  const messages = await listThreadMessages("gmail-push-thread", env);

  assert.equal(result.delivered.length, 2);
  assert.equal(result.resultSizeEstimate, 2);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /Classify this email: Alert one/);
  assert.match(messages[0].text, /First alert body/);
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/messages")).length, 2);
});

test("non-admin connector prompt pushes require the matching connector capability", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-push-user-cap-"));
  const env = { ORKESTR_HOME: home };
  await createUser({
    id: "alice",
    email: "alice@example.com",
    phoneNumber: "+15550001000",
    role: "user",
  }, env);
  await createThread({ id: "alice-thread", name: "Alice Thread", ownerUserId: "alice" }, env);
  const alice = userPrincipal({ id: "alice" });

  await assert.rejects(
    () => createConnectorPromptPushForPrincipal({
      connector: "gmail",
      threadId: "alice-thread",
      prompt: "Handle {{subject}}",
      sourceConfig: { query: "newer_than:1d" },
      enabled: true,
    }, alice, env),
    /connector_prompt_push_capability_required/,
  );
});
