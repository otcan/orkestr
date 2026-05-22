import assert from "node:assert/strict";
import test from "node:test";
import { demoAssetPath, renderDemoHtml } from "../scripts/record-demo.mjs";

test("README demo asset uses fake chat and web UI surfaces", () => {
  const html = renderDemoHtml();

  assert.match(demoAssetPath, /\.png$/);
  assert.match(html, /Demo Team Chat/);
  assert.match(html, /Web UI/);
  assert.match(html, /Codex Thread/);
  assert.match(html, /fake WhatsApp/);
  assert.match(html, /working -> ready/);
  assert.match(html, /<span class="prompt">status<\/span> ready/);
  assert.match(html, /Codex/);
  assert.match(html, /demo-launch/);
  assert.match(html, /Fake data only/);
});

test("README demo asset does not expose private identifiers", () => {
  const html = renderDemoHtml();
  const forbidden = [
    /\b\d{10,}\b/,
    /@(?:g\.us|c\.us|lid)\b/i,
    /\/home\/|\/root\//,
    /https?:\/\//i,
    /github\.com/i,
    /ops\.|oguzcan|openclaw|otcanclaw|metastate|peplab|magie|linkedin/i,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(html, pattern);
  }
});
