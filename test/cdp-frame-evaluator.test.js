import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createSameOriginFrameEvaluator } from "../packages/browsers/src/cdp-frame-evaluator.mjs";

const policy = { allowedOrigins: ["https://portal.example"], pathPrefix: "/journal/" };
const frame = () => ({ id: "child", loaderId: "document-one", url: "https://portal.example/journal/login" });
const tree = () => ({ frame: { url: "https://portal.example/journal/index" }, childFrames: [{ frame: frame() }] });
function fixture() {
  const f = { tree: tree(), calls: [], evaluationError: false };
  f.send = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "Page.getFrameTree") return { result: { frameTree: f.tree } };
    if (method === "Page.createIsolatedWorld") return { result: { executionContextId: f.calls.length } };
    if (method === "Runtime.evaluate") return f.evaluationError ? { result: { exceptionDetails: {} } } : { result: { result: { value: "evaluated" } } };
    throw new Error("unexpected method");
  };
  return f;
}
test("evaluates only in the unique direct same-origin frame and refreshes document context", async () => {
  const f = fixture();
  const evaluate = createSameOriginFrameEvaluator(f.send, policy);
  assert.equal(await evaluate("one"), "evaluated");
  await evaluate("two");
  assert.equal(f.calls.filter(x => x.method === "Page.createIsolatedWorld").length, 1);
  f.tree.childFrames[0].frame.loaderId = "document-two";
  await evaluate("new document");
  assert.equal(f.calls.filter(x => x.method === "Page.createIsolatedWorld").length, 2);
  for (const call of f.calls.filter(x => x.method === "Runtime.evaluate")) assert.ok(Number.isInteger(call.params.contextId));
  for (const call of f.calls.filter(x => x.method === "Page.createIsolatedWorld")) assert.equal(call.params.grantUniveralAccess, undefined);
});
test("rejects absent, ambiguous, cross-origin and out-of-policy frames before evaluation", async () => {
  for (const mutate of [
    x => { x.frame.url = "http://portal.example/journal/index"; },
    x => { x.frame.url = "https://portal.example.evil/journal/index"; },
    x => { x.frame.url = "https://portal.example/other/index"; },
    x => { x.childFrames = []; },
    x => { x.childFrames.push({ frame: { ...frame(), id: "other" } }); },
    x => { x.childFrames[0].frame.url = "https://other.example/journal/login"; },
    x => { x.childFrames[0].frame.url = "https://portal.example/other/login"; },
    x => { delete x.childFrames[0].frame.loaderId; }
  ]) {
    const f = fixture(); mutate(f.tree);
    await assert.rejects(createSameOriginFrameEvaluator(f.send, policy)("never evaluated"));
    assert.equal(f.calls.some(x => x.method === "Runtime.evaluate"), false);
  }
});
test("CDP failure refuses the action without retry and invalidates the old context", async () => {
  const f = fixture(), evaluate = createSameOriginFrameEvaluator(f.send, policy);
  await evaluate("first");
  f.evaluationError = true;
  await assert.rejects(evaluate("one failed action"), /no_retry/);
  assert.equal(f.calls.filter(x => x.method === "Runtime.evaluate").length, 2);
  f.evaluationError = false;
  await evaluate("explicit separate action");
  assert.equal(f.calls.filter(x => x.method === "Page.createIsolatedWorld").length, 2);
});
test("rejects unsafe policy and never treats policy as authority to open CDP", () => {
  for (const p of [{ ...policy, allowedOrigins: [] }, { ...policy, allowedOrigins: ["http://portal.example"] },
    { ...policy, allowedOrigins: ["https://portal.example/path"] }, { ...policy, pathPrefix: "/journal" }]) {
    assert.throws(() => createSameOriginFrameEvaluator(() => {}, p));
  }
});
test("navigation during world creation refuses the action before evaluation", async () => {
  const f = fixture(), send = f.send;
  f.send = async (method, params) => {
    const result = await send(method, params);
    if (method === "Page.createIsolatedWorld") {
      f.tree.childFrames[0].frame.loaderId = "new-loader";
      f.tree.childFrames[0].frame.url = "https://portal.example/other/login";
    }
    return result;
  };
  await assert.rejects(createSameOriginFrameEvaluator(f.send, policy)("action()"));
  assert.equal(f.calls.some(x => x.method === "Runtime.evaluate"), false);
});
test("navigation after tree validation cannot execute the action at a changed URL", async () => {
  const f = fixture(), send = f.send;
  let actions = 0;
  f.send = async (method, params) => {
    if (method === "Runtime.evaluate") {
      try {
        const value = vm.runInNewContext(params.expression, {
          location: { href: "https://portal.example/other/login" }, action() { actions++; }
        });
        return { result: { result: { value } } };
      } catch { return { result: { exceptionDetails: {} } }; }
    }
    return send(method, params);
  };
  await assert.rejects(createSameOriginFrameEvaluator(f.send, policy)("action()"), /no_retry/);
  assert.equal(actions, 0);
});
