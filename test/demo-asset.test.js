import assert from "node:assert/strict";
import test from "node:test";
import { demoAssetPath, renderDemoHtml } from "../scripts/record-demo.mjs";

test("README demo asset shows the same proof lines across WhatsApp, TMUX, and Web UI", () => {
  const html = renderDemoHtml();

  assert.match(demoAssetPath, /\.png$/);
  assert.match(html, /WhatsApp Source/);
  assert.match(html, /TMUX Capture/);
  assert.match(html, /Orkestr Web UI/);
  assert.match(html, /same lines/);
  assert.match(html, /otcanclaw: The PNG is on GitHub now\./);
  assert.match(html, /https:\/\/github\.com\/otcan\/orkestr\/blob\/main\/docs\/assets\/orkestr-three-screen-demo\.png/);
  assert.match(html, /https:\/\/raw\.githubusercontent\.com\/otcan\/orkestr\/main\/docs\/assets\/orkestr-three-screen-demo\.png/);
  assert.match(html, /raw URL returns HTTP 200 with content-type: image\/png/);
});

test("README demo asset does not expose private identifiers", () => {
  const html = renderDemoHtml();
  const forbidden = [
    /\b\d{10,}\b/,
    /@(?:g\.us|c\.us|lid)\b/i,
    /\/home\/|\/root\//,
    /ops\.|oguzcan|openclaw|metastate|peplab|magie|linkedin/i,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(html, pattern);
  }
});
