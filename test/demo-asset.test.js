import assert from "node:assert/strict";
import test from "node:test";
import { renderDemoSvg } from "../scripts/record-demo.mjs";

test("README demo asset uses a fake WhatsApp conversation", () => {
  const svg = renderDemoSvg();

  assert.match(svg, /Demo Team Chat/);
  assert.match(svg, /Status: working/);
  assert.match(svg, /Status: ready/);
  assert.match(svg, /Codex/);
  assert.match(svg, /demo-launch/);
  assert.match(svg, /Fake data only/);
});

test("README demo asset does not expose private identifiers", () => {
  const svg = renderDemoSvg();
  const forbidden = [
    /\b\d{10,}\b/,
    /@(?:g\.us|c\.us|lid)\b/i,
    /\/home\/|\/root\//,
    /https?:\/\/(?!www\.w3\.org\/2000\/svg)/i,
    /github\.com/i,
    /ops\.|oguzcan|openclaw|otcanclaw|metastate|peplab|magie|linkedin/i,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(svg, pattern);
  }
});
