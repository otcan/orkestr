import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGmailJobsPoll } from "../packages/connectors/src/gmail-jobs-queue.js";
import { listJobQueueForPrincipal, processJobCandidateMessages } from "../packages/core/src/jobs-queue.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { visibleThreadMessages } from "../packages/core/src/thread-message-visibility.js";
import { exchangeGmailCode } from "../packages/connectors/src/gmail.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { writeJson } from "../packages/storage/src/store.js";

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

test("Gmail jobs poll dedupes, classifies, and posts fits as passive signals", async () => {
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
  await writeJson(dataPaths(env).whatsapp, {
    outboundMirrorCursors: [{ messageSetKey: "thread||jobs-thread", cursor: 1 }],
    outboundDeliveries: [],
  });
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
  assert.equal(first.presentation.presented[0].fit.fitScore100, 80);
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
  assert.equal(messages[0].phase, "signal");
  assert.equal(messages[0].source, "jobs_queue");
  assert.equal(messages[0].connector, "gmail");
  assert.equal(messages[0].signalKind, "jobs");
  assert.equal(messages[0].signalMode, "notify_passively");
  assert.equal(messages[0].codexDeliveryMode, "passive");
  assert.equal(messages[0].originTransport, "jobs-passive-signal-notify");
  assert.equal(messages[0].chatId, "chat-jobs");
  assert.equal(messages[0].accountId, "wa-jobs");
  assert.match(messages[0].text, /1 new job fit/);
  assert.match(messages[0].text, /Fit rubric: 90-100 exceptional/);
  assert.match(messages[0].text, /AI Agent Lead at Acme/);
  assert.match(messages[0].text, /80\/100 \(strong\)/);
  assert.match(messages[0].text, /Queue ID: job_/);
  assert.doesNotMatch(messages[0].text, /Links:/);
  assert.doesNotMatch(messages[0].text, /https:\/\/jobs\.example\.com\/acme\/agent-lead/);
  assert.doesNotMatch(messages[0].text, /utm_source/);
  assert.equal(whatsappDelivery.delivered.length, 1);
  assert.equal(whatsappDelivery.delivered[0].deliveryType, "signal");
  assert.equal(whatsappCalls[0].url.pathname, "/send-text");
  assert.equal(whatsappCalls[0].body.to, "chat-jobs");
  assert.match(whatsappCalls[0].body.text, /AI Agent Lead at Acme/);
});

test("Gmail job signals can be recorded without WhatsApp delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-record-only-"));
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
  };
  await createThread({
    id: "jobs-record-thread",
    name: "Jobs Record Only",
    binding: { connector: "whatsapp", chatId: "chat-jobs-record", outboundAccountId: "wa-jobs" },
  }, env);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const result = await processJobCandidateMessages({
    threadId: "jobs-record-thread",
    maxResults: 1,
    signalMode: "record_only",
  }, [{
    id: "job-record-1",
    threadId: "gmail-thread-job-record-1",
    subject: "AI Platform Engineer at RecordCo",
    from: "jobs@recordco.example",
    snippet: "Remote AI platform role",
    text: "Remote AI platform role https://jobs.example.com/recordco/platform",
    internalDate: String(Date.parse("2026-06-30T10:00:00Z")),
  }], env, {
    classifyImpl: () => ({
      fit_score: 8,
      role: "AI Platform Engineer",
      company: "RecordCo",
      reason: "Strong platform match",
    }),
  });
  const messages = await listThreadMessages("jobs-record-thread", env);
  const whatsappCalls = [];
  const whatsappDelivery = await deliverWhatsAppReplies(env, async (url, options = {}) => {
    whatsappCalls.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ ok: true, ids: ["unexpected-record-only-send"] });
  });

  assert.equal(result.presentation.presented.length, 1);
  assert.equal(result.presentation.presented[0].fit.fitScore100, 80);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, "signal");
  assert.equal(messages[0].signalMode, "record_only");
  assert.equal(messages[0].codexDeliveryMode, "passive");
  assert.equal(messages.some((message) => message.role === "user" && message.state === "queued"), false);
  assert.equal(whatsappDelivery.delivered.length, 0);
  assert.equal(whatsappCalls.length, 0);
});

test("Gmail jobs poll rejects LinkedIn network suggestions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-linkedin-network-"));
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
  };
  await createThread({ id: "jobs-network-thread", name: "Jobs Network Suggestions" }, env);

  const result = await processJobCandidateMessages({
    threadId: "jobs-network-thread",
    maxResults: 1,
    signalMode: "record_only",
  }, [{
    id: "linkedin-network-1",
    threadId: "gmail-thread-linkedin-network-1",
    subject: "Firat, add Venkatesh Meka to your network at linkedin.com",
    from: "messages-noreply@linkedin.com",
    snippet: "People you may know",
    text: "People you may know. Connect on LinkedIn https://www.linkedin.com/comm/mynetwork/send-invite/venkatesh-meka/",
    internalDate: String(Date.parse("2026-06-30T10:00:00Z")),
  }], env);
  const queue = await listJobQueueForPrincipal(adminPrincipal(), env);
  const messages = await listThreadMessages("jobs-network-thread", env);

  assert.equal(result.classified.classified.length, 1);
  assert.equal(result.classified.classified[0].state, "queued_reject");
  assert.equal(result.classified.classified[0].fit.classifier, "non_job_filter");
  assert.equal(result.classified.classified[0].fit.fitScore100, 10);
  assert.equal(result.presentation.presented.length, 0);
  assert.equal(queue.counts.queued_reject, 1);
  assert.equal(messages.length, 0);
});

test("Gmail jobs poll rejects LinkedIn account notifications with profile keyword footers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-linkedin-notifications-"));
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
  };
  await createThread({ id: "jobs-linkedin-notifications-thread", name: "Jobs LinkedIn Notifications" }, env);

  const result = await processJobCandidateMessages({
    threadId: "jobs-linkedin-notifications-thread",
    maxResults: 3,
    signalMode: "record_only",
  }, [
    {
      id: "linkedin-accepted-1",
      threadId: "gmail-thread-linkedin-accepted-1",
      subject: "Maya accepted your invitation",
      from: "messages-noreply@linkedin.com",
      snippet: "Maya accepted your invitation to connect.",
      text: "Maya accepted your invitation to connect on LinkedIn.\n\nYour profile: AI Automation Engineer, Agent Workflows, Platform Product.",
      internalDate: String(Date.parse("2026-06-30T10:00:00Z")),
    },
    {
      id: "linkedin-searches-1",
      threadId: "gmail-thread-linkedin-searches-1",
      subject: "You appeared in 12 searches this week",
      from: "messages-noreply@linkedin.com",
      snippet: "See your search appearances.",
      text: "You appeared in 12 searches this week. Manage your email preferences.\nAI Automation Engineer. Agent Workflows.",
      internalDate: String(Date.parse("2026-06-30T10:01:00Z")),
    },
    {
      id: "linkedin-profile-views-1",
      threadId: "gmail-thread-linkedin-profile-views-1",
      subject: "Someone viewed your profile",
      from: "messages-noreply@linkedin.com",
      snippet: "See who viewed your profile.",
      text: "Who viewed your profile? LinkedIn Corporation. Unsubscribe.\nAI automation and platform work.",
      internalDate: String(Date.parse("2026-06-30T10:02:00Z")),
    },
  ], env);
  const queue = await listJobQueueForPrincipal(adminPrincipal(), env);
  const messages = await listThreadMessages("jobs-linkedin-notifications-thread", env);

  assert.equal(result.classified.classified.length, 3);
  assert.deepEqual(result.classified.classified.map((entry) => entry.state), ["queued_reject", "queued_reject", "queued_reject"]);
  assert.deepEqual(result.classified.classified.map((entry) => entry.fit.classifier), ["non_job_filter", "non_job_filter", "non_job_filter"]);
  assert.equal(result.presentation.presented.length, 0);
  assert.equal(queue.counts.queued_reject, 3);
  assert.equal(messages.length, 0);
});

test("Gmail jobs poll keeps real LinkedIn job alerts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-linkedin-alert-"));
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
  };
  await createThread({ id: "jobs-linkedin-alert-thread", name: "Jobs LinkedIn Alert" }, env);

  const result = await processJobCandidateMessages({
    threadId: "jobs-linkedin-alert-thread",
    maxResults: 1,
    signalMode: "record_only",
  }, [{
    id: "linkedin-job-alert-1",
    threadId: "gmail-thread-linkedin-job-alert-1",
    subject: "New job alert: AI Platform Engineer",
    from: "jobs-noreply@linkedin.com",
    snippet: "Remote AI automation role. Apply now.",
    text: "New job alert: AI Platform Engineer at LinkedCo. Remote automation platform role. Apply now https://www.linkedin.com/jobs/view/123456/",
    internalDate: String(Date.parse("2026-06-30T10:00:00Z")),
  }], env);
  const queue = await listJobQueueForPrincipal(adminPrincipal(), env);

  assert.equal(result.classified.classified.length, 1);
  assert.equal(result.classified.classified[0].state, "queued_fit");
  assert.equal(result.classified.classified[0].fit.classifier, "heuristic");
  assert.equal(result.presentation.presented.length, 1);
  assert.equal(queue.counts.presented, 1);
});

test("Gmail jobs poll uses configured fit agent command instead of heuristic", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-fit-agent-command-"));
  const fakeFitAgentScript = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "for await (const chunk of process.stdin) input += chunk;",
    "const payload = JSON.parse(input);",
    "if (!payload.candidate || !payload.candidate.subject.includes('AI Platform Engineer')) process.exit(2);",
    "console.log(JSON.stringify({",
    "  fit_score: 9,",
    "  fit_score_100: 91,",
    "  role: 'AI Platform Engineer',",
    "  company: 'FitAgentCo',",
    "  reason: 'Semantic LLM-style fit from external classifier.',",
    "  why_fit: 'Direct AI platform role match.',",
    "  classifier: 'llm_fake'",
    "}));",
  ].join("\n");
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
    ORKESTR_JOBS_FIT_AGENT_COMMAND_JSON: JSON.stringify([process.execPath, "--input-type=module", "--eval", fakeFitAgentScript]),
  };
  await createThread({ id: "jobs-fit-agent-command-thread", name: "Jobs Fit Agent Command" }, env);

  const result = await processJobCandidateMessages({
    threadId: "jobs-fit-agent-command-thread",
    maxResults: 1,
    signalMode: "record_only",
  }, [{
    id: "fit-agent-job-1",
    threadId: "gmail-thread-fit-agent-job-1",
    subject: "AI Platform Engineer at FitAgentCo",
    from: "jobs@fitagent.example",
    snippet: "Remote AI platform role.",
    text: "Remote AI platform role. Apply now https://jobs.example.com/fit-agent",
    internalDate: String(Date.parse("2026-06-30T10:00:00Z")),
  }], env);

  assert.equal(result.classified.classified.length, 1);
  assert.equal(result.classified.classified[0].state, "queued_fit");
  assert.equal(result.classified.classified[0].fit.classifier, "llm_fake");
  assert.equal(result.classified.classified[0].fit.fitScore100, 91);
});

test("Gmail jobs poll supports host-native gog collection", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-gog-"));
  const fakeGogScript = [
    "const args = process.argv.slice(1);",
    "if (args.includes('search')) {",
    "  console.log(JSON.stringify({ messages: [{ id: 'gog-job-1', threadId: 'gog-thread-1', subject: 'Remote Platform Lead at GogCo', from: 'jobs@gogco.example', date: '2026-06-30 12:00', snippet: 'AI remote platform role' }] }));",
    "} else if (args.includes('get')) {",
    "  console.log(JSON.stringify({ headers: { subject: 'Remote Platform Lead at GogCo', from: 'jobs@gogco.example', date: 'Tue, 30 Jun 2026 12:00:00 +0000', to: 'me@example.com' }, body: 'Remote AI platform job https://boards.example/gogco/platform?utm_source=gmail' }));",
    "} else {",
    "  process.exit(2);",
    "}",
    "",
  ].join("\n");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_JOBS_GMAIL_SOURCE: "gog",
    ORKESTR_JOBS_GOG_COMMAND_JSON: JSON.stringify([process.execPath, "--input-type=module", "--eval", fakeGogScript, "--"]),
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
  assert.match(messages[0].text, /90\/100 \(exceptional\)/);
  assert.match(messages[0].text, /Queue ID: job_/);
  assert.doesNotMatch(messages[0].text, /Links:/);
  assert.doesNotMatch(messages[0].text, /https:\/\/boards\.example\/gogco\/platform/);
  assert.doesNotMatch(messages[0].text, /utm_source/);
});

test("Gmail jobs poll does not hide revoked OAuth behind host-native fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-revoked-oauth-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_JOBS_GOG_COMMAND: path.join(home, "missing-gog"),
  };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () => jsonResponse({
    access_token: "jobs-access-stale",
    refresh_token: "jobs-refresh-revoked",
    expires_in: 3600,
  }));
  let calls = 0;

  await assert.rejects(
    () => runGmailJobsPoll({ maxResults: 1 }, env, async (url) => {
      calls += 1;
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, false, 400);
      }
      return jsonResponse({ error: { status: "UNAUTHENTICATED", message: "Invalid Credentials" } }, false, 401);
    }),
    /expired or revoked/,
  );

  assert.equal(calls, 2);
});
