import assert from "node:assert/strict";
import test from "node:test";
import {
  LINKEDIN_OUTREACH_SCOPE_STAGES,
  bindLinkedInOutreachPlan,
  loadLinkedInOutreachBindings,
  propagateLinkedInOutreachScope,
  restoreLinkedInOutreachWork,
} from "../packages/core/src/linkedin-outreach-scope.js";
import { executeLinkedInMcpPlan } from "../packages/core/src/linkedin-mcp-runtime.js";

const bindingA = Object.freeze({
  bindingId: "binding-sample-a",
  threadId: "thread-sample-a",
  desktopSlug: "linkedin-sample-a",
  outreachWorkspaceId: "workspace-sample-a",
  linkedinAccountAlias: "account-sample-a",
  oxrmEndpointId: "oxrm-sample-a",
  oxrmEndpoint: "https://oxrm-a.example.invalid/mcp/private-path-a",
});

const bindingB = Object.freeze({
  bindingId: "binding-sample-b",
  threadId: "thread-sample-b",
  desktopSlug: "linkedin-sample-b",
  outreachWorkspaceId: "workspace-sample-b",
  linkedinAccountAlias: "account-sample-b",
  oxrmEndpointId: "oxrm-sample-b",
  oxrmEndpoint: "https://oxrm-b.example.invalid/mcp/private-path-b",
});

const bindings = Object.freeze([bindingA, bindingB]);

function planFor(binding, calls = [{ tool: "linkedin.select_candidates", input: {}, stage: "selector" }]) {
  return {
    contractVersion: "linkedin.mcp.v1",
    runId: `run-${binding.bindingId}`,
    threadId: binding.threadId,
    desktopSlug: binding.desktopSlug,
    bindingId: binding.bindingId,
    outreachWorkspaceId: binding.outreachWorkspaceId,
    linkedinAccountAlias: binding.linkedinAccountAlias,
    calls,
  };
}

test("two LinkedIn outreach bindings resolve to isolated immutable scopes and endpoints", async () => {
  const normalized = await loadLinkedInOutreachBindings({ outreachBindings: bindings }, {});
  assert.equal(normalized.length, 2);
  assert.notEqual(normalized[0].bindingFingerprint, normalized[1].bindingFingerprint);
  assert.notEqual(normalized[0].oxrmEndpoint, normalized[1].oxrmEndpoint);

  const first = await bindLinkedInOutreachPlan(planFor(bindingA), { outreachBindings: bindings }, {});
  const second = await bindLinkedInOutreachPlan(planFor(bindingB), { outreachBindings: bindings }, {});
  assert.equal(first.plan.calls[0].input.outreachWorkspaceId, bindingA.outreachWorkspaceId);
  assert.equal(first.plan.calls[0].input.linkedinAccountAlias, bindingA.linkedinAccountAlias);
  assert.equal(first.plan.outreachScope.oxrmEndpoint, undefined);
  assert.equal(second.plan.outreachScope.oxrmEndpointId, bindingB.oxrmEndpointId);
  assert.notEqual(first.plan.outreachScope.bindingFingerprint, second.plan.outreachScope.bindingFingerprint);
});

test("scope survives detached, recovery, and requeue transitions without widening", async () => {
  const bound = await bindLinkedInOutreachPlan(planFor(bindingA), { outreachBindings: bindings }, {});
  const detached = propagateLinkedInOutreachScope({
    id: "work-sample-a",
    threadId: bindingA.threadId,
    desktopSlug: bindingA.desktopSlug,
  }, bound.scope, "detached_worker");
  const recovered = await restoreLinkedInOutreachWork(detached, { outreachBindings: bindings, stage: "recovery" }, {});
  const requeued = await restoreLinkedInOutreachWork(recovered.work, { outreachBindings: bindings, stage: "requeue" }, {});

  assert.deepEqual(requeued.work.outreachScope, bound.plan.outreachScope);
  assert.equal(recovered.work.outreachScopeStage, "recovery");
  assert.equal(requeued.work.outreachScopeStage, "requeue");
  assert.equal(JSON.stringify(requeued.work).includes(bindingA.oxrmEndpoint), false);
});

test("every outreach lifecycle stage preserves the exact same scope snapshot", async () => {
  const bound = await bindLinkedInOutreachPlan(planFor(bindingA), { outreachBindings: bindings }, {});
  for (const stage of LINKEDIN_OUTREACH_SCOPE_STAGES) {
    const staged = propagateLinkedInOutreachScope({ id: `work-${stage}` }, bound.scope, stage);
    assert.deepEqual(staged.outreachScope, bound.plan.outreachScope);
    assert.equal(staged.outreachScopeStage, stage);
  }
  await assert.rejects(
    restoreLinkedInOutreachWork({
      bindingId: bindingA.bindingId,
      threadId: bindingA.threadId,
      desktopSlug: bindingA.desktopSlug,
      outreachWorkspaceId: bindingA.outreachWorkspaceId,
      linkedinAccountAlias: bindingA.linkedinAccountAlias,
    }, { outreachBindings: bindings, stage: "requeue" }, {}),
    { message: "linkedin_outreach_scope_snapshot_missing" },
  );
});

test("foreign and stale scope snapshots are rejected", async () => {
  await assert.rejects(
    bindLinkedInOutreachPlan({
      ...planFor(bindingA),
      outreachWorkspaceId: bindingB.outreachWorkspaceId,
    }, { outreachBindings: bindings }, {}),
    { message: "linkedin_outreach_scope_mismatch" },
  );

  const bound = await bindLinkedInOutreachPlan(planFor(bindingA), { outreachBindings: bindings }, {});
  const changedBinding = { ...bindingA, oxrmEndpoint: "https://oxrm-a.example.invalid/mcp/replaced" };
  await assert.rejects(
    restoreLinkedInOutreachWork(bound.plan, { outreachBindings: [changedBinding], stage: "requeue" }, {}),
    { message: "linkedin_outreach_scope_stale" },
  );
});

test("call mismatch fails before desktop lease or browser action and audit stays redacted", async () => {
  let leaseCalls = 0;
  let browserCalls = 0;
  const events = [];
  const plan = planFor(bindingA, [{
    tool: "linkedin.select_candidates",
    stage: "claim",
    input: {
      outreachWorkspaceId: bindingB.outreachWorkspaceId,
      linkedinAccountAlias: bindingB.linkedinAccountAlias,
    },
  }]);

  await assert.rejects(
    executeLinkedInMcpPlan(plan, {
      outreachBindings: bindings,
      appendEventFn: async (event) => events.push(event),
      acquireDesktopLeaseFn: async () => { leaseCalls += 1; return { ok: true, lease: {} }; },
      operateManagedDesktopFn: async () => { browserCalls += 1; return { ok: true }; },
    }),
    { message: "linkedin_outreach_scope_mismatch" },
  );

  assert.equal(leaseCalls, 0);
  assert.equal(browserCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "linkedin_outreach_scope_rejected");
  assert.equal(events[0].outreachWorkspaceId, bindingA.outreachWorkspaceId);
  assert.equal(events[0].oxrmEndpointId, bindingA.oxrmEndpointId);
  assert.equal(JSON.stringify(events).includes(bindingA.oxrmEndpoint), false);
});

test("runtime injects only the binding-resolved endpoint and redacts it from status", async () => {
  const internalEndpoints = [];
  const runtimeModule = {
    createLinkedInRuntimeHandlers({ outreachScope, oxrm }) {
      internalEndpoints.push([outreachScope.bindingId, oxrm.endpoint]);
      return {
        "linkedin.select_candidates": async (input) => ({
          ok: true,
          inputScope: input.outreachScope,
          oxrmEndpoint: oxrm.endpoint,
          note: `selected through ${oxrm.endpoint}`,
        }),
      };
    },
    createLinkedInMcpServer({ handlers }) {
      return { callTool: (name, input, context) => handlers[name](input, context) };
    },
  };

  const results = [];
  for (const binding of bindings) {
    results.push(await executeLinkedInMcpPlan(planFor(binding), {
      outreachBindings: bindings,
      linkedinModule: runtimeModule,
      acquireLease: false,
      appendEventFn: async () => {},
      desktopAdapter: { observe: async () => ({}), perform: async () => ({}) },
    }));
  }

  assert.deepEqual(internalEndpoints, [
    [bindingA.bindingId, bindingA.oxrmEndpoint],
    [bindingB.bindingId, bindingB.oxrmEndpoint],
  ]);
  assert.equal(results[0].results[0].result.oxrmEndpointId, bindingA.oxrmEndpointId);
  assert.equal(results[1].results[0].result.oxrmEndpointId, bindingB.oxrmEndpointId);
  assert.equal(JSON.stringify(results).includes(bindingA.oxrmEndpoint), false);
  assert.equal(JSON.stringify(results).includes(bindingB.oxrmEndpoint), false);
});

test("ambiguous or unsafe endpoint bindings fail closed without exposing endpoint data", async () => {
  await assert.rejects(
    loadLinkedInOutreachBindings({ outreachBindings: [bindingA, { ...bindingA }] }, {}),
    { message: "linkedin_outreach_binding_ambiguous" },
  );
  await assert.rejects(
    loadLinkedInOutreachBindings({ outreachBindings: [{
      ...bindingA,
      oxrmEndpoint: "https://operator:secret@oxrm-a.example.invalid/mcp?token=private",
    }] }, {}),
    (error) => error.message === "linkedin_outreach_oxrm_endpoint_invalid"
      && !error.message.includes("secret")
      && !JSON.stringify(error.outreachScope || {}).includes("private"),
  );
});
