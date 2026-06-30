import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGmailJobsPoll } from "../packages/connectors/src/gmail-jobs-queue.js";
import { listJobQueueForPrincipal } from "../packages/core/src/jobs-queue.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { visibleThreadMessages } from "../packages/core/src/thread-message-visibility.js";
import { exchangeGmailCode } from "../packages/connectors/src/gmail.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
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

function gmailMessage({ id, subject, from, snippet, text }) {
  return {
    id,
    threadId: `gmail-thread-${id}`,
    snippet,
    internalDate: String(Date.parse("2026-06-30T10:00:00Z")),
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
        { name: "To", value: "me@example.com" },
        { name: "Date", value: "Tue, 30 Jun 2026 10:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(text, "utf8").toString("base64url") },
    },
  };
}

test("Gmail jobs poll dedupes, classifies, and posts fits as notifications", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-queue-"));
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
  };
  await createThread({
    id: "jobs-thread",
    name: "Jobs",
    binding: { connector: "whatsapp", chatId: "chat-jobs", outboundAccountId: "wa-jobs" },
  }, env);
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "jobs-gmail-access",
      refresh_token: "jobs-gmail-refresh",
      expires_in: 3600,
    }),
  );

  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers.authorization, "Bearer jobs-gmail-access");
    if (url.pathname.endsWith("/messages") && !url.pathname.match(/\/messages\/[^/]+$/)) {
      assert.equal(url.searchParams.get("q"), "newer_than:1d job");
      assert.equal(url.searchParams.get("maxResults"), "2");
      return jsonResponse({
        messages: [{ id: "job-msg-1" }, { id: "job-msg-2" }],
        resultSizeEstimate: 2,
      });
    }
    if (url.pathname.endsWith("/messages/job-msg-1")) {
      return jsonResponse(gmailMessage({
        id: "job-msg-1",
        subject: "AI Agent Lead at Acme",
        from: "recruiter@acme.example",
        snippet: "Remote platform role",
        text: "Remote AI automation role https://jobs.example.com/acme/agent-lead?utm_source=gmail",
      }));
    }
    if (url.pathname.endsWith("/messages/job-msg-2")) {
      return jsonResponse(gmailMessage({
        id: "job-msg-2",
        subject: "Warehouse shift",
        from: "alerts@example.com",
        snippet: "Onsite only",
        text: "Onsite only warehouse shift https://jobs.example.com/warehouse",
      }));
    }
    throw new Error(`unexpected Gmail fetch ${url.href}`);
  };
  const classifyImpl = (candidate) => candidate.gmailMessageId === "job-msg-1"
    ? {
        fit_score: 8,
        role: "AI Agent Lead",
        company: "Acme",
        location: "Europe",
        remote: "remote",
        why_fit: "AI automation and platform work",
        risks: "Recruiter screen required",
        next_action: "review link",
      }
    : {
        fit_score: 3,
        role: "Warehouse shift",
        company: "Example",
        reason: "Not relevant",
        risks: "Onsite only",
      };

  const first = await runGmailJobsPoll({
    threadId: "jobs-thread",
    query: "newer_than:1d job",
    maxResults: 2,
  }, env, fetchImpl, { classifyImpl });
  const duplicate = await runGmailJobsPoll({
    threadId: "jobs-thread",
    query: "newer_than:1d job",
    maxResults: 2,
  }, env, fetchImpl, { classifyImpl });
  const queue = await listJobQueueForPrincipal(adminPrincipal(), env);
  const messages = await listThreadMessages("jobs-thread", env);
  const visible = visibleThreadMessages(messages);
  const whatsappCalls = [];
  const whatsappDelivery = await deliverWhatsAppReplies(env, async (url, options = {}) => {
    whatsappCalls.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ ok: true, ids: ["sent-job-digest"] });
  });

  assert.equal(first.upserted.created.length, 2);
  assert.equal(first.classified.classified.length, 2);
  assert.equal(first.presentation.presented.length, 1);
  assert.equal(duplicate.upserted.created.length, 0);
  assert.equal(duplicate.upserted.duplicates.length, 2);
  assert.equal(duplicate.classified.classified.length, 0);
  assert.equal(duplicate.presentation.presented.length, 0);
  assert.equal(queue.counts.presented, 1);
  assert.equal(queue.counts.queued_reject, 1);
  assert.equal(visible.length, 1);
  assert.equal(messages.some((message) => message.role === "user" && message.state === "queued"), false);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].state, "completed");
  assert.equal(messages[0].phase, "notification");
  assert.equal(messages[0].source, "jobs_queue");
  assert.equal(messages[0].connector, "gmail");
  assert.equal(messages[0].chatId, "chat-jobs");
  assert.equal(messages[0].accountId, "wa-jobs");
  assert.match(messages[0].text, /1 new job fit/);
  assert.match(messages[0].text, /AI Agent Lead at Acme/);
  assert.match(messages[0].text, /https:\/\/jobs\.example\.com\/acme\/agent-lead/);
  assert.doesNotMatch(messages[0].text, /utm_source/);
  assert.equal(whatsappDelivery.delivered.length, 1);
  assert.equal(whatsappCalls[0].url.pathname, "/send-text");
  assert.equal(whatsappCalls[0].body.to, "chat-jobs");
  assert.match(whatsappCalls[0].body.text, /AI Agent Lead at Acme/);
});

test("Gmail jobs poll supports host-native gog collection", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-gog-"));
  const fakeGog = path.join(home, "fake-gog.mjs");
  await fs.writeFile(fakeGog, [
    "const args = process.argv.slice(2);",
    "if (args.includes('search')) {",
    "  console.log(JSON.stringify({ messages: [{ id: 'gog-job-1', threadId: 'gog-thread-1', subject: 'Remote Platform Lead at GogCo', from: 'jobs@gogco.example', date: '2026-06-30 12:00', snippet: 'AI remote platform role' }] }));",
    "} else if (args.includes('get')) {",
    "  console.log(JSON.stringify({ headers: { subject: 'Remote Platform Lead at GogCo', from: 'jobs@gogco.example', date: 'Tue, 30 Jun 2026 12:00:00 +0000', to: 'me@example.com' }, body: 'Remote AI platform job https://boards.example/gogco/platform?utm_source=gmail' }));",
    "} else {",
    "  process.exit(2);",
    "}",
    "",
  ].join("\n"), "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_JOBS_GMAIL_SOURCE: "gog",
    ORKESTR_JOBS_GOG_COMMAND_JSON: JSON.stringify([process.execPath, fakeGog]),
  };
  await createThread({ id: "gog-jobs-thread", name: "Gog Jobs" }, env);

  const result = await runGmailJobsPoll({
    threadId: "gog-jobs-thread",
    query: "newer_than:1d job",
    maxResults: 1,
  }, env, fetch, {
    classifyImpl: () => ({
      fit_score: 9,
      role: "Remote Platform Lead",
      company: "GogCo",
      reason: "Strong platform and AI match",
    }),
  });
  const queue = await listJobQueueForPrincipal(adminPrincipal(), env);
  const messages = await listThreadMessages("gog-jobs-thread", env);

  assert.equal(result.collected, 1);
  assert.equal(result.presentation.presented.length, 1);
  assert.equal(queue.counts.presented, 1);
  assert.match(messages[0].text, /Remote Platform Lead at GogCo/);
  assert.match(messages[0].text, /https:\/\/boards\.example\/gogco\/platform/);
  assert.doesNotMatch(messages[0].text, /utm_source/);
});
