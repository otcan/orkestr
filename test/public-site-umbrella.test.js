import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { maybeServePublicSite } from "../dist/server/apps/server/src/public-site-static.js";
import { publicCatalog, publicCatalogEntryIsLive } from "../dist/server/apps/server/src/public-site-catalog.js";

const env = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/example/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};
const host = { host: "product.example.test" };

function serve(url) {
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    status(code) { result.status = code; return response; },
    header(name, value) { result.headers[name] = value; return response; },
    type() { return response; },
    send(body) { result.body = body; return response; },
  };
  const handled = maybeServePublicSite({ headers: { host: "product.example.test" } }, response, url, env);
  return { handled, ...result };
}

test("root is the umbrella page with the approved headline, CTAs, and nav", () => {
  const html = renderPublicSite("/", env, host);
  assert.match(html, /<h1 id="home-title">We turn complex ideas into working software\.<\/h1>/);
  assert.match(html, /<a class="button" href="\/free">Explore free products<\/a>/);
  assert.match(html, /<a class="button button-ghost" href="\/studio">Discuss a project<\/a>/);
  const nav = html.match(/<nav class="desktop-nav"[^>]*>(.*?)<\/nav>/s)[1];
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((match) => match[1]), ["Free products", "Open source", "Studio"]);
  for (const path of ["/free", "/open-source", "/studio"]) assert.match(html, new RegExp(`class="hub-entry-card"[\\s\\S]*href="${path}"`));
  assert.doesNotMatch(html, /\/builds|Live builds|Simulation/);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/"/);
  assert.match(html, /href="\/impressum"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/support"/);
  assert.match(html, /Client Portal/);
  assert.doesNotMatch(html, /\/api\/public\/events|data-event=|<form|book_project_header/);
  assert.doesNotMatch(html, /class="language-switcher"/);
});

test("the free index lists catalog entries with status badges and only link live pages", () => {
  for (const section of ["free"]) {
    const html = renderPublicSite(`/${section}`, env, host);
    assert.match(html, new RegExp(`<a href="/${section}" aria-current="page">`));
    const entries = publicCatalog.filter((entry) => entry.section === section);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      const live = publicCatalogEntryIsLive(entry);
      assert.match(html, new RegExp(entry.title));
      if (live) assert.match(html, new RegExp(`href="/${section}/${entry.slug}"`));
      else assert.doesNotMatch(html, new RegExp(`href="/${section}/${entry.slug}"`));
    }
    assert.match(html, /class="hub-badge hub-status-(live|soon)"/);
    assert.doesNotMatch(html, /\/api\/public\/events|<form/);
  }
});

test("pending catalog entries are not routable; registered live entries are", () => {
  const pending = publicCatalog.find((entry) => !publicCatalogEntryIsLive(entry));
  if (pending) assert.equal(renderPublicSite(`/${pending.section}/${pending.slug}`, env, host), "");
  const entry = { section: "free", slug: "fixture-build", title: "Fixture build", summary: "Synthetic fixture.", status: "live", render: () => ({ id: "free", title: "Fixture build", summary: "Synthetic fixture.", canonicalPath: "/free/fixture-build", body: '<main id="main-content"><h1>Fixture build</h1></main>' }) };
  publicCatalog.push(entry);
  try {
    const page = renderPublicSite("/free/fixture-build", env, host);
    assert.match(page, /<h1>Fixture build<\/h1>/);
    assert.match(page, /rel="canonical" href="https:\/\/product\.example\.test\/free\/fixture-build"/);
    assert.match(page, /<a href="\/free" aria-current="true">/);
    const index = renderPublicSite("/free", env, host);
    assert.match(index, /href="\/free\/fixture-build"/);
    assert.match(renderPublicSitemap(env), /<loc>https:\/\/product\.example\.test\/free\/fixture-build<\/loc>/);
    const slash = serve("/free/fixture-build/");
    assert.equal(slash.status, 301);
    assert.equal(slash.headers.location, "/free/fixture-build");
  } finally {
    publicCatalog.splice(publicCatalog.indexOf(entry), 1);
  }
});

test("open-source placeholder renders and links to the repository", () => {
  const html = renderPublicSite("/open-source", env, host);
  assert.match(html, /Run your coding agent, leave your desk, and stay in control\./);
  assert.match(html, /href="https:\/\/github\.com\/example\/orkestr"/);
  assert.match(html, /<a href="\/open-source" aria-current="page">/);
});

test("moved localized homes redirect permanently to their studio pages", () => {
  for (const [from, to] of [["/de", "/de/studio"], ["/tr", "/tr/studio"], ["/de/", "/de/studio"], ["/tr?x=1", "/tr/studio?x=1"]]) {
    const result = serve(from);
    assert.equal(result.handled, true, from);
    assert.equal(result.status, 301, from);
    assert.equal(result.headers.location, to, from);
  }
  for (const path of ["/", "/free", "/open-source", "/studio", "/de/studio", "/tr/studio", "/project", "/security", "/impressum", "/privacy", "/terms", "/support", "/developers"]) {
    const result = serve(path);
    assert.equal(result.status, 200, path);
    assert.match(result.body, /<main\b/, path);
  }
});

test("EN/DE/TR routing stays consistent: no stale alternates or untranslated umbrella labels", () => {
  const sitemap = renderPublicSitemap(env);
  const paths = [...new Set([...sitemap.matchAll(/<loc>https:\/\/product\.example\.test([^<]*)<\/loc>/g)].map((match) => match[1] || "/"))];
  const localized = paths.filter((path) => /^\/(de|tr)\//.test(path)).concat(["/de/projekt", "/tr/proje"]);
  assert.ok(localized.length >= 22);
  for (const path of paths.concat(["/de/projekt", "/tr/proje"])) {
    const html = renderPublicSite(path, env, host);
    const targets = [
      ...[...html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="https:\/\/product\.example\.test([^"]*)"/g)].map((match) => match[1] || "/"),
      ...[...html.matchAll(/class="(?:mobile-)?language-switcher[^"]*"[^>]*>(.*?)<\/(?:nav|div)>/gs)].flatMap((match) => [...match[1].matchAll(/href="([^"]+)"/g)].map((link) => link[1])),
    ];
    for (const target of targets) {
      const result = serve(target);
      assert.equal(result.status, 200, `${path} -> ${target}`);
    }
  }
  for (const path of localized) {
    const html = renderPublicSite(path, env, host);
    const nav = html.match(/<nav class="desktop-nav"[^>]*>(.*?)<\/nav>/s)[1];
    assert.doesNotMatch(nav, />(Live builds|Free products|Open source)</, path);
    for (const target of ["/free", "/open-source"]) assert.match(nav, new RegExp(`href="${target}" hreflang="en"`), path);
    assert.match(nav, new RegExp(`href="/${path.split("/")[1]}/studio"`), path);
    assert.doesNotMatch(html, />Explore</, path);
    assert.doesNotMatch(html, /href="\/(builds|free|open-source)"(?! hreflang="en")/, path);
  }
  const root = renderPublicSite("/", env, host);
  assert.match(root, /href="\/de\/studio" hreflang="de-DE" lang="de">Deutsch</);
  assert.match(root, /href="\/tr\/studio" hreflang="tr-TR" lang="tr">Türkçe</);
  assert.doesNotMatch(root, /rel="alternate"/);
});

test("free products and open source never load the analytics beacon or tracked attributes", () => {
  const tracking = /\/api\/public\/events|orkestrTrack|sendBeacon|data-event=|data-view-event=/;
  const fixtures = [
    { section: "free", slug: "beacon-fixture", title: "Beacon fixture", summary: "Synthetic.", status: "live" },
  ].map((entry) => ({ ...entry, render: () => ({ id: entry.section, title: entry.title, summary: entry.summary, canonicalPath: `/${entry.section}/${entry.slug}`, body: '<main id="main-content"><h1>Fixture</h1><a href="#" data-event="book_project_hero" data-view-event="platform_console_view">x</a></main>' }) }));
  publicCatalog.push(...fixtures);
  try {
    for (const path of ["/free", "/open-source", "/free/beacon-fixture"]) {
      const html = renderPublicSite(path, env, host);
      assert.match(html, /<main\b/, path);
      assert.doesNotMatch(html, tracking, path);
    }
  } finally {
    for (const entry of fixtures) publicCatalog.splice(publicCatalog.indexOf(entry), 1);
  }
  for (const path of ["/studio", "/de/studio", "/project", "/security", "/privacy"]) {
    const html = renderPublicSite(path, env, host);
    assert.match(html, /\/api\/public\/events/, path);
    assert.match(html, /data-event="client_portal_click"/, path);
  }
});

test("the removed /builds section answers 410 Gone and is not linked or listed", () => {
  for (const path of ["/builds", "/builds/", "/builds/customer-portal", "/builds/evidence-desk", "/builds/evidence-desk/evidence-desk-app.js"]) {
    const result = serve(path);
    assert.equal(result.handled, true, path);
    assert.equal(result.status, 410, path);
  }
  assert.doesNotMatch(renderPublicSitemap(env), /\/builds/);
  for (const path of ["/", "/free", "/open-source", "/studio", "/de/studio", "/tr/studio"]) assert.doesNotMatch(renderPublicSite(path, env, host), /href="\/builds/, path);
});
