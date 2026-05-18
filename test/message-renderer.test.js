import assert from "node:assert/strict";
import test from "node:test";
import { hasProposedPlanTag, renderMessageTextHtml, stripProposedPlanTags } from "../apps/web/src/app/message-renderer.ts";

test("message renderer hides proposed plan tags while preserving plan content", () => {
  const raw = [
    "<proposed plan>",
    "Next should be **real-world launch validation**, not more feature work.",
    "",
    "1. Pair the first browser",
    "</proposed plan>",
  ].join("\n");

  assert.equal(hasProposedPlanTag(raw), true);
  assert.doesNotMatch(stripProposedPlanTags(raw), /proposed plan/i);
  const html = renderMessageTextHtml(raw);
  assert.doesNotMatch(html, /proposed plan/i);
  assert.match(html, /real-world launch validation/);
  assert.match(html, /<ol class="orkestr-message-list">/);
});
