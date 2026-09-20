import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { googleWorkspaceReviewActionsPageHtml } from "../dist/server/apps/server/src/modules/connectors/google-workspace-review-actions-page.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function harness(capabilities) {
  const buttons = ["gmail-read", "gmail-draft", "gmail-send", "calendar-list", "calendar-create"].map(action => ({
    dataset: { action }, textContent: action, disabled: false,
    addEventListener(_name, listener) { this.click = listener; },
  }));
  const nodes = new Map(["result", "account-title", "account-detail"].map(id => [id, { textContent: "" }]));
  const mutations = [], confirmations = [];
  let approve = false, finish;
  vm.runInNewContext(googleWorkspaceReviewActionsPageHtml().match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: id => nodes.get(id), querySelectorAll: () => buttons },
    window: { confirm: question => { confirmations.push(question); return approve; } },
    fetch: async (url, options) => {
      if (options?.method === "POST") {
        mutations.push({ url, body: JSON.parse(options.body) });
        await new Promise(resolve => { finish = resolve; });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true, connected: true, account: { email: "reviewer@example.test", capabilities } }) };
    },
  });
  await tick();
  return { buttons, mutations, confirmations, approve: () => { approve = true; }, finish: () => finish() };
}

test("review actions follow granted capabilities and cancelling confirmation sends nothing", async () => {
  const fixture = await harness(["gmail_send"]);
  assert.deepEqual(fixture.buttons.map(button => button.disabled), [true, true, false, true, true]);
  await fixture.buttons[0].click();
  await fixture.buttons[2].click();
  assert.equal(fixture.mutations.length, 0);
  assert.match(fixture.confirmations[0], /reviewer@example.test/);
});

test("confirmed mutations carry explicit consent and pending work blocks duplicate clicks", async () => {
  for (const [action, capability] of [["gmail-send", "gmail_send"], ["calendar-create", "calendar_actions"]]) {
    const fixture = await harness([capability]); fixture.approve();
    const button = fixture.buttons.find(candidate => candidate.dataset.action === action);
    const pending = button.click(); await tick();
    assert.equal(fixture.mutations.length, 1);
    assert.deepEqual(fixture.mutations[0].body, { confirmed: true });
    assert.equal(fixture.buttons.every(candidate => candidate.disabled), true);
    await button.click();
    assert.equal(fixture.mutations.length, 1);
    fixture.finish(); await pending;
    assert.equal(button.disabled, false);
  }
});
