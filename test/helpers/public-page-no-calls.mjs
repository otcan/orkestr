import assert from "node:assert/strict";

// Shared check for public pages that promise "after this page loads, it sends
// nothing back". Delivering the page and its static assets over HTTP is fine;
// what is forbidden is page code making application-data or analytics calls
// after load, and the site analytics beacon being present at all.
//
// Usage:
//   assertNoCallsAfterLoad(html, { label: "/free/example", loadScript: (src) => sourceText });
// `loadScript` resolves same-origin <script src> URLs to their source so the
// check also covers external page code. Cross-origin scripts always fail.
//
// A service worker that only re-fetches the page's own same-origin static
// assets is static delivery, not a data call. Check it with
// assertStaticAssetWorker(source, assetPaths) instead of exempting it blindly.

const callPatterns = [
  ["fetch()", /(^|[^\w.$])fetch\s*\(|\.fetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["navigator.sendBeacon", /\bsendBeacon\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
];

const beaconPatterns = [
  ["analytics endpoint", /\/api\/public\/events/],
  ["analytics helper", /\borkestrTrack\b/],
  ["tracked click attribute", /\sdata-event="/],
  ["tracked view attribute", /\sdata-view-event="/],
];

export function scriptSources(html) {
  const inline = [];
  const external = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] || "";
    const src = attrs.match(/\ssrc="([^"]+)"/i)?.[1];
    if (src) external.push(src);
    else if (!/type="application\/(ld\+)?json"/i.test(attrs)) inline.push(match[2] || "");
  }
  return { inline, external };
}

export function findCallsInCode(code) {
  return callPatterns.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

export function assertNoCallsAfterLoad(html, { label = "page", loadScript } = {}) {
  for (const [name, pattern] of beaconPatterns) assert.doesNotMatch(html, pattern, `${label}: ${name} present`);
  assert.doesNotMatch(html, /\son[a-z]+="/i, `${label}: inline event handler`);
  const { inline, external } = scriptSources(html);
  inline.forEach((code, index) => assert.deepEqual(findCallsInCode(code), [], `${label}: inline script #${index + 1} makes calls`));
  for (const src of external) {
    assert.ok(src.startsWith("/") && !src.startsWith("//"), `${label}: cross-origin script ${src}`);
    assert.equal(typeof loadScript, "function", `${label}: pass loadScript to check ${src}`);
    const code = loadScript(src);
    assert.equal(typeof code, "string", `${label}: could not load ${src}`);
    assert.deepEqual(findCallsInCode(code), [], `${label}: ${src} makes calls`);
    for (const [name, pattern] of beaconPatterns.slice(0, 2)) assert.doesNotMatch(code, pattern, `${label}: ${src} contains ${name}`);
  }
}

export function assertStaticAssetWorker(code, assetPaths, label = "service worker") {
  const calls = findCallsInCode(code).filter((name) => name !== "fetch()");
  assert.deepEqual(calls, [], `${label}: makes non-fetch calls`);
  for (const [name, pattern] of beaconPatterns.slice(0, 2)) assert.doesNotMatch(code, pattern, `${label}: contains ${name}`);
  assert.match(code, /url\.origin\s*!==\s*self\.location\.origin/, `${label}: must ignore cross-origin requests`);
  assert.ok(Array.isArray(assetPaths) && assetPaths.length > 0, `${label}: list the static assets it may fetch`);
  assert.doesNotMatch(code, /method\s*[:=]\s*["'](POST|PUT|PATCH|DELETE)/i, `${label}: sends data`);
}
