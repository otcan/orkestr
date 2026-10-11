import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite } from "../dist/server/apps/server/src/public-site.js";
import { publicCatalog, publicNoCallsNotice } from "../dist/server/apps/server/src/public-site-catalog.js";
import { assertNoCallsAfterLoad, assertStaticAssetWorker, findCallsInCode } from "./helpers/public-page-no-calls.mjs";

const env = { ORKESTR_PUBLIC_SITE_URL: "https://product.example.test", ORKESTR_PUBLIC_REPO_URL: "https://github.com/example/orkestr" };
const host = { host: "product.example.test" };

test("no-calls helper flags data and analytics calls but allows static delivery", () => {
  for (const code of ["fetch('/x')", "window.fetch(url)", "new XMLHttpRequest()", "navigator.sendBeacon(u, b)", "new WebSocket(u)", "new EventSource(u)"]) {
    assert.notDeepEqual(findCallsInCode(code), [], code);
  }
  assert.deepEqual(findCallsInCode("localStorage.setItem('k', JSON.stringify(state)); prefetchCount += 1;"), []);
  const page = '<html><head><link rel="stylesheet" href="/public-site.css"><script type="application/ld+json">{"fetch(":1}</script></head><body><main><script src="/app.js"></script></main></body></html>';
  assertNoCallsAfterLoad(page, { label: "fixture", loadScript: () => "document.title = 'ok';" });
  assert.throws(() => assertNoCallsAfterLoad(page, { label: "fixture", loadScript: () => "fetch('/api/x')" }));
  assert.throws(() => assertNoCallsAfterLoad('<main><script src="https://cdn.example.test/x.js"></script></main>', { loadScript: () => "" }));
  assert.throws(() => assertNoCallsAfterLoad('<main><a data-event="x">x</a></main>'));
  const worker = "self.addEventListener('fetch', (event) => { const url = new URL(event.request.url); if (url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return; event.respondWith(fetch(event.request)); });";
  assertStaticAssetWorker(worker, ["/free/example/app.js"]);
  assert.throws(() => assertStaticAssetWorker(worker.replace("url.origin !== self.location.origin || ", ""), ["/a.js"]));
  assert.throws(() => assertStaticAssetWorker(`${worker} navigator.sendBeacon('/x', '')`, ["/a.js"]));
  assert.throws(() => assertNoCallsAfterLoad(renderPublicSite("/studio", env, host), { label: "/studio" }), "studio still carries the beacon");
});

test("umbrella pages make no calls after load and carry no analytics beacon", () => {
  for (const path of ["/", "/free", "/open-source"]) assertNoCallsAfterLoad(renderPublicSite(path, env, host), { label: path });
});

test("the no-calls notice is shown only for live local-only entries whose page passes the check", () => {
  const entry = {
    section: "free", slug: "no-calls-fixture", title: "No-calls fixture", summary: "Synthetic.", status: "live", localOnly: true,
    render: () => ({ id: "free", title: "No-calls fixture", summary: "Synthetic.", canonicalPath: "/free/no-calls-fixture", body: `<main id="main-content"><h1>Fixture</h1><p>${publicNoCallsNotice}</p><script>localStorage.setItem("k", "v");</script></main>` }),
  };
  assert.match(publicNoCallsNotice, /^After this page loads, it sends nothing back: no analytics, no data uploads\. Your entries stay in this browser\.$/);
  assert.doesNotMatch(renderPublicSite("/free", env, host), /After this page loads/);
  publicCatalog.push(entry);
  try {
    assert.match(renderPublicSite("/free", env, host), /class="hub-local-only">After this page loads, it sends nothing back/);
    for (const live of publicCatalog.filter((item) => item.localOnly && item.status === "live" && item.render)) {
      const path = `/${live.section}/${live.slug}`;
      assertNoCallsAfterLoad(renderPublicSite(path, env, host), { label: path });
    }
  } finally {
    publicCatalog.splice(publicCatalog.indexOf(entry), 1);
  }
});
