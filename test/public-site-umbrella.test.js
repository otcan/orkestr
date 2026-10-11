import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { maybeServePublicSite } from "../dist/server/apps/server/src/public-site-static.js";
import { publicCatalog } from "../dist/server/apps/server/src/public-site-catalog.js";

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
  assert.match(html, /<a class="button" href="\/builds">Explore live builds<\/a>/);
  assert.match(html, /<a class="button button-ghost" href="\/studio">Discuss a project<\/a>/);
  const nav = html.match(/<nav class="desktop-nav"[^>]*>(.*?)<\/nav>/s)[1];
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((match) => match[1]), ["Live builds", "Free products", "Open source", "Studio"]);
  for (const path of ["/builds", "/free", "/open-source", "/studio"]) assert.match(html, new RegExp(`class="hub-entry-card"[\\s\\S]*href="${path}"`));
  for (const label of ["Simulation", "Recorded run", "Live, isolated"]) assert.match(html, new RegExp(label));
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/"/);
  assert.match(html, /href="\/impressum"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/support"/);
  assert.match(html, /Client Portal/);
  assert.doesNotMatch(html, /\/api\/public\/events|data-event=|<form|book_project_header/);
  assert.doesNotMatch(html, /class="language-switcher"/);
});

test("builds and free indexes list catalog entries with status badges and only link live pages", () => {
  for (const section of ["builds", "free"]) {
    const html = renderPublicSite(`/${section}`, env, host);
    assert.match(html, new RegExp(`<a href="/${section}" aria-current="page">`));
    const entries = publicCatalog.filter((entry) => entry.section === section);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      const live = entry.status === "live" && typeof entry.render === "function";
      assert.match(html, new RegExp(entry.title));
      if (live) assert.match(html, new RegExp(`href="/${section}/${entry.slug}"`));
      else assert.doesNotMatch(html, new RegExp(`href="/${section}/${entry.slug}"`));
    }
    assert.match(html, /class="hub-badge hub-status-(live|soon)"/);
    assert.doesNotMatch(html, /\/api\/public\/events|<form/);
  }
});

test("pending catalog entries are not routable; registered live entries are", () => {
  const pending = publicCatalog.find((entry) => !(entry.status === "live" && entry.render));
  if (pending) assert.equal(renderPublicSite(`/${pending.section}/${pending.slug}`, env, host), "");
  const entry = { section: "builds", slug: "fixture-build", title: "Fixture build", summary: "Synthetic fixture.", status: "live", evidence: "simulation", render: () => ({ id: "builds", title: "Fixture build", summary: "Synthetic fixture.", canonicalPath: "/builds/fixture-build", body: '<main id="main-content"><h1>Fixture build</h1></main>' }) };
  publicCatalog.push(entry);
  try {
    const page = renderPublicSite("/builds/fixture-build", env, host);
    assert.match(page, /<h1>Fixture build<\/h1>/);
    assert.match(page, /rel="canonical" href="https:\/\/product\.example\.test\/builds\/fixture-build"/);
    assert.match(page, /<a href="\/builds" aria-current="true">/);
    const index = renderPublicSite("/builds", env, host);
    assert.match(index, /href="\/builds\/fixture-build"/);
    assert.match(index, /hub-evidence-simulation/);
    assert.match(renderPublicSitemap(env), /<loc>https:\/\/product\.example\.test\/builds\/fixture-build<\/loc>/);
    const slash = serve("/builds/fixture-build/");
    assert.equal(slash.status, 301);
    assert.equal(slash.headers.location, "/builds/fixture-build");
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
  for (const path of ["/", "/builds", "/free", "/open-source", "/studio", "/de/studio", "/tr/studio", "/project", "/security", "/impressum", "/privacy", "/terms", "/support", "/developers"]) {
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
    for (const target of ["/builds", "/free", "/open-source"]) assert.match(nav, new RegExp(`href="${target}" hreflang="en"`), path);
    assert.match(nav, new RegExp(`href="/${path.split("/")[1]}/studio"`), path);
    assert.doesNotMatch(html, />Explore</, path);
  }
  const root = renderPublicSite("/", env, host);
  assert.match(root, /href="\/de\/studio" hreflang="de-DE" lang="de">Deutsch</);
  assert.match(root, /href="\/tr\/studio" hreflang="tr-TR" lang="tr">Türkçe</);
  assert.doesNotMatch(root, /rel="alternate"/);
});
