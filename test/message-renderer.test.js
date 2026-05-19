import assert from "node:assert/strict";
import test from "node:test";
import { hasProposedPlanEnvelope, renderMessageTextHtml, stripProposedPlanEnvelope } from "../apps/web/src/app/message-renderer.ts";

test("message renderer hides proposed plan envelopes while preserving plan content", () => {
  const raw = [
    "<proposed plan>",
    "Next should be **real-world launch validation**, not more feature work.",
    "",
    "1. Pair the first browser",
    "</proposed plan>",
  ].join("\n");

  assert.equal(hasProposedPlanEnvelope(raw), true);
  assert.doesNotMatch(stripProposedPlanEnvelope(raw), /proposed plan/i);
  const html = renderMessageTextHtml(raw);
  assert.doesNotMatch(html, /proposed plan/i);
  assert.match(html, /real-world launch validation/);
  assert.match(html, /<ol class="orkestr-message-list">/);
});

test("message renderer preserves inline proposed plan mentions in final answers", () => {
  const raw = "The literal `<proposed_plan>` tag should not make this a plan.";

  assert.equal(hasProposedPlanEnvelope(raw), false);
  assert.equal(stripProposedPlanEnvelope(raw), raw);
  const html = renderMessageTextHtml(raw);
  assert.match(html, /&lt;proposed_plan&gt;/);
});
