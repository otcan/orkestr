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

test("message renderer formats markdown tables as responsive web tables", () => {
  const html = renderMessageTextHtml([
    "Here is the current queue:",
    "",
    "| Thread | State | Notes |",
    "| --- | --- | --- |",
    "| Worker 1 | ready | [open](https://example.com/w1) |",
    "| Worker 2 | `queued` | needs **attention** |",
    "",
    "Done.",
  ].join("\n"));

  assert.match(html, /<div class="orkestr-message-table-wrap">/);
  assert.match(html, /<table class="orkestr-message-table">/);
  assert.match(html, /<th>Thread<\/th>/);
  assert.match(html, /<td>Worker 1<\/td>/);
  assert.match(html, /<a class="orkestr-message-link" href="https:\/\/example\.com\/w1"/);
  assert.match(html, /<code class="orkestr-inline-code">queued<\/code>/);
  assert.match(html, /<strong>attention<\/strong>/);
});

test("message renderer does not format tables inside fenced code blocks", () => {
  const html = renderMessageTextHtml([
    "```",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "```",
  ].join("\n"));

  assert.doesNotMatch(html, /orkestr-message-table/);
  assert.match(html, /<pre class="orkestr-code-block"><code>/);
  assert.match(html, /\| A \| B \|/);
});
