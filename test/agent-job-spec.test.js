import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AgentJobSpecError,
  agentJobToolDecision,
  normalizeAgentJobSpec,
  parseDurationMs,
  validateAgentJobSpec,
} from "../packages/core/src/agent-job-spec.js";
import { loadAgentJobYaml, parseAgentJobYaml } from "../packages/core/src/agent-job-spec-yaml.js";

const examplesDir = new URL("../examples/jobs/", import.meta.url);

function minimalJob(overrides = {}) {
  return {
    apiVersion: "orkestr/v0",
    kind: "AgentJob",
    metadata: { name: "example-job" },
    triggers: [{ type: "api" }],
    agent: { provider: "simulated" },
    task: { prompt: "Do the example task." },
    ...overrides,
  };
}

function errorCodes(input) {
  const result = validateAgentJobSpec(input);
  assert.equal(result.ok, false);
  return result.errors.map((error) => `${error.path}:${error.code}`);
}

test("every example job file validates", async () => {
  const files = (await fs.readdir(examplesDir)).filter((file) => file.endsWith(".yaml"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const spec = await loadAgentJobYaml(await fs.readFile(new URL(file, examplesDir), "utf8"));
    assert.equal(spec.metadata.name, path.basename(file, ".yaml"), file);
  }
});

test("minimal job gets documented defaults", () => {
  const spec = normalizeAgentJobSpec(minimalJob());
  assert.deepEqual(spec.runtime, {
    durable: true,
    maxAttempts: 3,
    timeoutMs: 30 * 60_000,
    approvalTimeoutMs: 24 * 3_600_000,
    concurrency: "forbid",
    retry: { backoff: "exponential", initialDelayMs: 30_000, maxDelayMs: 600_000 },
  });
  assert.deepEqual(spec.permissions, { tools: { allow: [], deny: [], approvalRequired: [] }, secrets: [] });
  assert.deepEqual(spec.agent, { provider: "simulated", model: null, fallback: [] });
  assert.deepEqual(spec.notifications, []);
  assert.equal(spec.metadata.description, "");
});

test("normalization does not alias caller objects", () => {
  const input = minimalJob({ task: { prompt: "x", inputs: { nested: { a: 1 } } } });
  const spec = normalizeAgentJobSpec(input);
  spec.task.inputs.nested.a = 2;
  assert.equal(input.task.inputs.nested.a, 1);
});

test("unknown fields are rejected at every level", () => {
  assert.deepEqual(errorCodes(minimalJob({ extra: true })), ["$.extra:unknown_field"]);
  assert.deepEqual(errorCodes(minimalJob({ agent: { provider: "simulated", temperature: 1 } })), ["agent.temperature:unknown_field"]);
  assert.deepEqual(errorCodes(minimalJob({ runtime: { retries: 3 } })), ["runtime.retries:unknown_field"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "api", path: "/x" }] })), ["triggers[0].path:unknown_field"]);
});

test("header, name and required sections are enforced", () => {
  assert.deepEqual(errorCodes(minimalJob({ apiVersion: "orkestr/v1" })), ["apiVersion:invalid_value"]);
  assert.deepEqual(errorCodes(minimalJob({ metadata: { name: "Bad_Name" } })), ["metadata.name:invalid_format"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [] })), ["triggers:invalid_type"]);
  const { task, ...withoutTask } = minimalJob();
  assert.deepEqual(errorCodes(withoutTask), ["task:required"]);
  assert.deepEqual(errorCodes(null), ["$:invalid_type"]);
});

test("schedule triggers mirror timer cadences", () => {
  const spec = normalizeAgentJobSpec(minimalJob({ triggers: [{ type: "schedule", cadence: "interval", every: "15m" }] }));
  assert.deepEqual(spec.triggers, [{ type: "schedule", cadence: "interval", everyMs: 900_000, timezone: "UTC" }]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "schedule", cadence: "interval", every: "10s" }] })), [
    "triggers[0].every:out_of_range",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "schedule", cadence: "daily", time: "25:00" }] })), [
    "triggers[0].time:invalid_format",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "schedule", cadence: "daily", every: "1h", time: "09:00" }] })), [
    "triggers[0].every:not_allowed",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "schedule", cadence: "cron" }] })), ["triggers[0].cadence:invalid_value"]);
});

test("webhook triggers need a vault secret ref and unique names", () => {
  const hook = { type: "webhook", name: "push", secret_ref: "vault://example-secret", event_id: "/id" };
  const spec = normalizeAgentJobSpec(minimalJob({ triggers: [hook] }));
  assert.deepEqual(spec.triggers[0], { type: "webhook", name: "push", secretRef: "vault://example-secret", eventId: "/id" });
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ ...hook, secret_ref: "plain-text-secret" }] })), [
    "triggers[0].secret_ref:invalid_format",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [hook, hook] })), ["triggers[1].name:duplicate"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ ...hook, event_id: "id" }] })), ["triggers[0].event_id:invalid_format"]);
});

test("agent providers, fallbacks and openai-compatible requirements", () => {
  assert.deepEqual(errorCodes(minimalJob({ agent: { provider: "gpt" } })), ["agent.provider:invalid_value"]);
  assert.deepEqual(errorCodes(minimalJob({ agent: { provider: "openai-compatible" } })).sort(), [
    "agent.base_url:required",
    "agent.model:required",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ agent: { provider: "codex", base_url: "http://x.example" } })), [
    "agent.base_url:not_allowed",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ agent: { provider: "codex", fallback: [{ provider: "codex" }] } })), [
    "agent.fallback[0]:duplicate",
  ]);
  const tooMany = [{ provider: "simulated" }, { provider: "codex" }, { provider: "claude-code" }, { provider: "codex", model: "m" }];
  assert.deepEqual(errorCodes(minimalJob({ agent: { provider: "simulated", model: "a", fallback: tooMany } })), ["agent.fallback:too_many"]);
});

test("tool permissions are default-deny with deny > approval_required > allow", () => {
  const spec = normalizeAgentJobSpec(
    minimalJob({
      permissions: {
        tools: { allow: ["github.*"], approval_required: ["github.pull_request.merge"], deny: ["github.repo.delete"] },
      },
    }),
  );
  assert.equal(agentJobToolDecision(spec, "github.pull_request.create"), "allow");
  assert.equal(agentJobToolDecision(spec, "github"), "allow");
  assert.equal(agentJobToolDecision(spec, "github.pull_request.merge"), "approval_required");
  assert.equal(agentJobToolDecision(spec, "github.repo.delete"), "deny");
  assert.equal(agentJobToolDecision(spec, "githubx.read"), "deny");
  assert.equal(agentJobToolDecision(spec, "shell.exec"), "deny");
  assert.deepEqual(
    errorCodes(minimalJob({ permissions: { tools: { approval_required: ["mail.send"], deny: ["mail.*"] } } })),
    ["permissions.tools.approval_required[0]:conflict"],
  );
  assert.deepEqual(errorCodes(minimalJob({ permissions: { tools: { allow: ["Shell Exec"] } } })), [
    "permissions.tools.allow[0]:invalid_format",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ permissions: { secrets: ["ghp_example"] } })), ["permissions.secrets[0]:invalid_format"]);
});

test("runtime limits and non-durable jobs", () => {
  assert.deepEqual(errorCodes(minimalJob({ runtime: { max_attempts: 0 } })), ["runtime.max_attempts:out_of_range"]);
  assert.deepEqual(errorCodes(minimalJob({ runtime: { max_attempts: 21 } })), ["runtime.max_attempts:out_of_range"]);
  assert.deepEqual(errorCodes(minimalJob({ runtime: { durable: false } })), ["runtime.max_attempts:conflict"]);
  assert.equal(normalizeAgentJobSpec(minimalJob({ runtime: { durable: false, max_attempts: 1 } })).runtime.durable, false);
  assert.deepEqual(errorCodes(minimalJob({ runtime: { retry: { initial_delay: "5m", max_delay: "1m" } } })), [
    "runtime.retry.max_delay:out_of_range",
  ]);
  assert.deepEqual(errorCodes(minimalJob({ runtime: { timeout: "soon" } })), ["runtime.timeout:invalid_duration"]);
});

test("notifications validate events, channels and webhook targets", () => {
  assert.deepEqual(
    errorCodes(minimalJob({ notifications: [{ on: ["exploded"], channel: "thread", target: "t" }] })),
    ["notifications[0].on[0]:invalid_value", "notifications[0].on:required"],
  );
  assert.deepEqual(
    errorCodes(minimalJob({ notifications: [{ on: ["failed"], channel: "webhook", target: "http://hooks.example.com" }] })),
    ["notifications[0].target:invalid_format"],
  );
});

test("parseDurationMs accepts the documented units only", () => {
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs(1500), 1500);
  assert.equal(parseDurationMs("1 hour"), null);
  assert.equal(parseDurationMs(-1), null);
});

test("YAML parsing rejects anchors, aliases, custom tags and duplicate keys", async () => {
  const base = "apiVersion: orkestr/v0\nkind: AgentJob\n";
  await assert.rejects(parseAgentJobYaml(`${base}metadata: &m { name: a }\nother: *m\n`), (error) => {
    assert.ok(error instanceof AgentJobSpecError);
    assert.ok(error.errors.some((entry) => entry.code === "yaml_anchor"));
    assert.ok(error.errors.some((entry) => entry.code === "yaml_alias"));
    return true;
  });
  await assert.rejects(parseAgentJobYaml(`${base}metadata: !custom { name: a }\n`), /yaml_tag/);
  await assert.rejects(parseAgentJobYaml(`${base}kind: AgentJob\n`), /yaml_syntax/);
  await assert.rejects(loadAgentJobYaml(`${base}metadata: { name: a }\n`), /triggers required/);
});

test("whatsapp triggers need a group, an allowlist of senders and a valid pattern", () => {
  const ok = minimalJob({ triggers: [{ type: "whatsapp", group: "120363000000000001@g.us", senders: ["+15550100001", "15550100002@s.whatsapp.net"], match: "^/fix" }] });
  const result = validateAgentJobSpec(ok);
  assert.equal(result.ok, true);
  assert.deepEqual(result.spec.triggers[0], { type: "whatsapp", group: "120363000000000001@g.us", senders: ["+15550100001", "15550100002@s.whatsapp.net"], match: "^/fix" });
  assert.equal(validateAgentJobSpec(minimalJob({ triggers: [{ type: "whatsapp", group: "binding:example-binding", senders: ["+15550100001"] }] })).ok, true);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "whatsapp", group: "15550100001@c.us", senders: ["+15550100001"] }] })), ["triggers[0].group:invalid_format"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "whatsapp", group: "120363000000000001@g.us" }] })), ["triggers[0].senders:required"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "whatsapp", group: "120363000000000001@g.us", senders: ["everyone"] }] })), ["triggers[0].senders[0]:invalid_format"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "whatsapp", group: "120363000000000001@g.us", senders: ["+15550100001"], match: "(" }] })), ["triggers[0].match:invalid_format"]);
  assert.deepEqual(errorCodes(minimalJob({ triggers: [{ type: "email" }] })), ["triggers[0].type:invalid_value"]);
});

test("the simulated provider is a test fixture and rejected outside tests", () => {
  const job = minimalJob();
  assert.equal(validateAgentJobSpec(job).ok, true, "allowed under node --test");
  const outside = validateAgentJobSpec(job, { allowTestProviders: false });
  assert.deepEqual(outside.errors.map((e) => `${e.path}:${e.code}`), ["agent.provider:test_only_provider"]);
  assert.equal(validateAgentJobSpec(minimalJob({ agent: { provider: "codex" } }), { allowTestProviders: false }).ok, true);
});
