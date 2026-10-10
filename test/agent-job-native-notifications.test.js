// A native executor's approval pause (codex and claude-code) parks the run
// through the runner, so its approval notification goes through the relay and
// the notification dispatcher like any other run. Offline: fake CLIs and fake
// transports; nothing is sent.
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAgentJobNotifications } from "../packages/connectors/src/agent-job-notification-dispatcher.js";
import { relayAgentJobNotifications } from "../packages/connectors/src/agent-job-notification-relay.js";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { stopCodexJobClients } from "../packages/core/src/codex-job-client.js";
import { makeSpec } from "./fixtures/agent-job-fixtures.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";
import { codexJobEnv } from "./fixtures/codex-job-fixtures.js";

test.afterEach(() => stopCodexJobClients());

const notifications = [{ on: ["approval_required"], channel: "whatsapp", target: "binding:example-binding" }];

const providers = {
  codex: {
    env: () => codexJobEnv({ script: [{ command: ["make", "release"] }, { final: { summary: "released" } }] }),
    tool: "codex.command",
  },
  "claude-code": {
    env: async () => (await fakeClaude([{ tools: [{ name: "Bash", input: { command: "make release" } }], final: "released" }])).env,
    tool: "claude.bash",
  },
};

function fakeTransports(sent) {
  return {
    async whatsapp(input) {
      sent.push(input);
      return { ok: true, sent: [{ id: `wamid-${sent.length}` }] };
    },
    async resolveBinding(id) {
      return id === "example-binding" ? { chatId: "120363000000000001@g.us", accountId: "example-account" } : null;
    },
  };
}

for (const [provider, { env: makeEnv, tool }] of Object.entries(providers)) {
  test(`${provider}: a native approval pause is notified through the dispatcher with the approve/deny hint`, async () => {
    const env = { ...(await makeEnv()), ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" };
    const restore = setAgentJobProviderProbe(provider, async () => ({ connected: true }));
    try {
      const spec = makeSpec({ name: `${provider}-notify`, provider, notifications, tools: { allow: [], approval_required: [tool] } });
      const { run } = await admitRun({ spec, type: "api", dedupeKey: "evt-1" }, env);
      const parked = await driveRun(run.id, {}, env);
      assert.equal(parked.state, "awaiting_approval", JSON.stringify(parked));
      await relayAgentJobNotifications({}, env);
      const sent = [];
      const results = await dispatchAgentJobNotifications({ transports: fakeTransports(sent) }, env);
      assert.deepEqual(results.map((entry) => entry.state), ["delivered"]);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].chatId, "120363000000000001@g.us");
      assert.match(sent[0].text, new RegExp(`approve ${parked.approvalId}`));
      assert.match(sent[0].text, new RegExp(`deny ${parked.approvalId}`));
      assert.match(sent[0].text, new RegExp(tool.replace(".", "\\.")));
      // Delivered once: a second dispatch sends nothing.
      await dispatchAgentJobNotifications({ transports: fakeTransports(sent) }, env);
      assert.equal(sent.length, 1);
    } finally {
      restore();
    }
  });
}
