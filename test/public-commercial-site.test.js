import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";

const baseEnv = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};

test("commercial homepage presents one simple booking-first business-system journey", () => {
  const html = renderPublicSite("/", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Custom Business Software &amp; Automation \| Orkestr<\/title>/);
  assert.match(html, /Need a better system for your business/);
  assert.match(html, /Book a 20-minute project call/);
  assert.match(html, /data-event="book_project_hero"/);
  assert.equal((html.match(/<section class="v4-section/g) || []).length, 6);
  for (const heading of ["Build new systems", "Modernize existing systems", "Automate work and data"]) assert.match(html, new RegExp(heading));
  assert.match(html, /We need a new B2B website/);
  assert.match(html, /Our internal system is old/);
  assert.match(html, /repeatedly searches websites/);
  for (const step of ["Talk", "Define", "Build", "Operate"]) assert.match(html, new RegExp(`<h3>${step}<\/h3>`));
  assert.match(html, /Internal Ordering Renewal · Migration Run #042/);
  assert.match(html, /Built to keep working after launch/);
  assert.match(html, /Client Portal/);
  assert.doesNotMatch(html, /Personal beta/);
  assert.doesNotMatch(html, /Bring us an ugly problem/i);
  assert.doesNotMatch(html, /class="browser-section"/);
  assert.doesNotMatch(html, /class="approval-card"/);
  assert.doesNotMatch(html, /class="section faq"/);
  assert.doesNotMatch(html, /id="requirement-example"/);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/"/);
  assert.match(html, /"@type":"Organization"/);
  assert.match(html, /"@type":"WebSite"/);
  assert.match(html, /"@type":"Person"/);
  for (const alternate of ['hreflang="en" href="https://product.example.test/"', 'hreflang="de-DE" href="https://product.example.test/de"', 'hreflang="tr-TR" href="https://product.example.test/tr"', 'hreflang="x-default"']) assert.match(html, new RegExp(alternate));
  assert.doesNotMatch(html, /"@type":"BreadcrumbList"/);
});

test("German and Turkish homepages are native, canonical, and reciprocal", () => {
  const expectations = [
    ["/de", "de-DE", "Individuelle Unternehmenssoftware", "Braucht Ihr Unternehmen ein besseres System", "/de/projekt#book", "ORKESTR-KONSOLE · ÖFFENTLICHE DEMO", "Datenschutz"],
    ["/tr", "tr-TR", "Özel İş Yazılımı", "İşletmeniz için daha iyi bir sisteme", "/tr/proje#book", "ORKESTR KONSOLU · HERKESE AÇIK DEMO", "Gizlilik"],
  ];
  for (const [path, language, title, heading, booking, consoleLabel, privacyLabel] of expectations) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(`<html lang="${language}">`));
    assert.match(html, new RegExp(`<title>${title}`));
    assert.match(html, new RegExp(heading));
    assert.match(html, new RegExp(`href="${booking}"`));
    assert.match(html, new RegExp(`rel="canonical" href="https:\/\/product\.example\.test${path}"`));
    for (const alternate of ["en", "de-DE", "tr-TR"]) assert.match(html, new RegExp(`hreflang="${alternate}"`));
    assert.match(html, /class="language-switcher"/);
    assert.match(html, new RegExp(consoleLabel));
    assert.match(html, new RegExp(`>${privacyLabel}<`));
    assert.doesNotMatch(html, /Internal Ordering Renewal/);
    assert.doesNotMatch(html, /ORKESTR CONSOLE · PUBLIC DEMO/);
  }
});

test("localized commercial routes keep focused intent and a working short project form", () => {
  const pages = [
    ["/de/altsystem-modernisieren", "Altsysteme modernisieren", "Projektgespräch buchen"],
    ["/de/ki-prozessautomatisierung", "Geschäftsprozesse mit KI", "Workflow-Audit"],
    ["/tr/eski-sistem-modernizasyonu", "Eski sisteminizi", "Proje görüşmesi planla"],
    ["/tr/yapay-zeka-is-akisi-otomasyonu", "iş süreçlerini yapay zekâ", "İş Akışı Analizi"],
  ];
  for (const [path, heading, cta] of pages) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(heading, "i"));
    assert.match(html, new RegExp(cta, "i"));
    assert.match(html, /"@type":"BreadcrumbList"/);
  }
  for (const path of ["/de/projekt", "/tr/proje"]) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, /id="quick-project-form"/);
    assert.match(html, /\/api\/public\/project-inquiries/);
    for (const field of ["projectType", "desiredOutcome", "contactName", "workEmail", "consentToContact"]) assert.match(html, new RegExp(`name="${field}"`));
  }
});

test("team pages present one accountable founder with factual Person data", () => {
  const expectations = [["/team", "Orkestr is led"], ["/de/team", "Orkestr wird"], ["/tr/ekip", "Orkestr'i Oğuzcan"]];
  for (const [path, heading] of expectations) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(heading));
    assert.match(html, /Oğuzcan Ünver/);
    assert.match(html, /"@type":"Person"/);
    assert.match(html, /"@type":"ProfilePage"/);
    assert.doesNotMatch(html, /Our team of|Unser Team aus|uzman ekibimiz/i);
    assert.doesNotMatch(html, /larger team|permanent Orkestr team|größer dar|dauerhaftes Orkestr-Team|daha büyük bir ekip|kalıcı bir Orkestr ekibi|göstermez/i);
  }
});

test("public copy avoids defensive internal-positioning language across every locale", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const indexedPaths = [...sitemap.matchAll(/<loc>https:\/\/product\.example\.test([^<]*)<\/loc>/g)].map((match) => match[1] || "/");
  const utilityPaths = ["/project", "/de/projekt", "/tr/proje", "/privacy", "/terms", "/impressum", "/acceptable-use", "/data-deletion", "/support", "/beta"];
  const banned = /pretend|larger team|permanent Orkestr team|größer dar|dauerhaftes Orkestr-Team|daha büyük bir ekip|kalıcı bir Orkestr ekibi|honest no-fit|ehrliche Absage|uygun değil yanıtı|modischer Technologie|moda bir teknoloji|not every project|nicht jedes Projekt|her proje her|we do not prescribe|empfehlen keine KI|önermiyoruz|nützlichen Teil|gerekli kısmı|more than a hand-off|mehr als eine Software-Übergabe|teslim edip gitmek/i;
  const paths = [...new Set([...indexedPaths, ...utilityPaths])];
  assert.equal(paths.length, 42);
  for (const path of paths) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.doesNotMatch(html, banned, path);
  }
});

test("localized commercial routes do not leak English section labels", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const paths = [...sitemap.matchAll(/<loc>https:\/\/product\.example\.test\/(de|tr)(\/[^<]*)?<\/loc>/g)].map((match) => `/${match[1]}${match[2] || ""}`);
  paths.push("/de/projekt", "/tr/proje");
  assert.equal(new Set(paths).size, 22);
  for (const path of new Set(paths)) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.doesNotMatch(html, /BUSINESS SYSTEMS &amp; AUTOMATION|PROJECT DISCOVERY|ORKESTR CONSOLE · PUBLIC DEMO/, path);
  }
});

test("workflow route collects a bounded map before offering a scheduling handoff", () => {
  const html = renderPublicSite("/workflow", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Book a Workflow Audit \| Orkestr<\/title>/);
  assert.match(html, /Show us one workflow worth fixing/);
  assert.match(html, /A useful workflow map beats a generic demo call/);
  assert.match(html, /id="workflow-form"/);
  assert.match(html, /\/api\/public\/workflow-leads/);
  assert.match(html, /monthlyVolume/);
  assert.match(html, /workflowOwner/);
  assert.match(html, /consentToContact/);
  assert.match(html, /id="scheduling-handoff"/);
  assert.match(html, /qualified_schedule_click/);
  assert.match(html, />Request workflow audit<\/button>/);
  assert.match(html, /"@type":"BreadcrumbList"/);
});

test("workflow route never exposes or depends on a scheduler before qualification", () => {
  const html = renderPublicSite("/workflow", {
    ...baseEnv,
    ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL: "https://calendar.example.test/orkestr/qualification",
  }, { host: "product.example.test" });

  assert.match(html, /id="workflow-form"/);
  assert.doesNotMatch(html, /calendar\.example\.test/);
  assert.doesNotMatch(html, /Online scheduling is being connected/);
  assert.doesNotMatch(html, /mailto:/);
});

test("project route exposes direct booking and a four-answer adaptive alternative", () => {
  const html = renderPublicSite("/project", { ...baseEnv, ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL: "https://calendar.example.test/discovery" }, { host: "product.example.test" });

  assert.match(html, /<title>Book a Project Call \| Orkestr<\/title>/);
  assert.match(html, /Let’s talk about what should work better/);
  assert.match(html, /20-minute project call/i);
  assert.match(html, /href="https:\/\/calendar\.example\.test\/discovery"/);
  assert.match(html, /data-event="project_booking_click"/);
  assert.match(html, /id="quick-project-form"/);
  assert.match(html, /\/api\/public\/project-inquiries/);
  for (const field of ["projectType", "desiredOutcome", "contactName", "workEmail"]) assert.match(html, new RegExp(`name="${field}"[^>]*required|name="${field}"[^>]*type="[^"]+"[^>]*required`));
  assert.match(html, /name="intakeMode" type="hidden" value="quick"/);
  assert.match(html, /systemsOrSources/);
  assert.match(html, /consentToContact/);
  assert.match(html, /Optional: What happens today/);
  assert.match(html, /project_type_selected/);
  assert.doesNotMatch(html, /Submit project for review/);
});

test("project route falls back to a native call request when no scheduler is configured", () => {
  const html = renderPublicSite("/project", baseEnv, { host: "product.example.test" });
  assert.match(html, /Request a project call/);
  assert.match(html, /href="#quick-project-form" data-event="project_call_request_click"/);
  assert.doesNotMatch(html, /calendar\.example\.test/);
});

test("commercial detail pages keep plain-language headings, evidence, limitations, and unique metadata", () => {
  const expectations = [
    ["/security", "Business System Security &amp; Control", "Your systems stay under your control", "What Orkestr can—and cannot—work with"],
    ["/deployment", "Business System Deployment &amp; Operation", "Know where the system runs", "Four steps from idea to live operation"],
    ["/use-cases", "Business Systems &amp; Automation Services", "Five ways to turn a business requirement", "Start with what needs to happen"],
    ["/developers", "Open-Source Orkestr Operating Layer", "Software you can inspect, run, and question", "Run the core locally"],
  ];

  for (const [path, title, heading, evidence] of expectations) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(`<title>${title} \\| Orkestr<\\/title>`));
    assert.match(html, new RegExp(heading));
    assert.match(html, new RegExp(evidence));
    assert.match(html, /Book a project call/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, new RegExp(`rel="canonical" href="https:\\/\\/product\\.example\\.test${path}"`));
  }
});

test("solution pages are bounded, truthful, and preserve the specialized automation audit", () => {
  const expectations = [
    ["/websites-commerce", "Strong software", "standard web technologies"],
    ["/business-systems", "Staged modernization", "staged migration"],
    ["/opportunity-intelligence", "Never manually search", "public or explicitly authorized"],
    ["/web-data-monitoring", "Reliable, structured data", "does not bypass access controls"],
    ["/automation", "Persistent work", "Book a Workflow Audit"],
  ];
  for (const [path, heading, boundary] of expectations) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(heading));
    assert.match(html, new RegExp(boundary));
    assert.match(html, /Book a project call/);
    assert.match(html, /Illustrative|BOUNDARIES|What Discovery must establish/);
  }
});

test("sitemap prioritizes localized commercial routes and accessible progressive enhancement", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const css = renderPublicSiteCss();

  for (const path of ["/", "/workflow", "/websites-commerce", "/business-systems", "/opportunity-intelligence", "/web-data-monitoring", "/automation", "/security", "/deployment", "/use-cases", "/developers", "/team", "/de", "/de/altsystem-modernisieren", "/de/ki-prozessautomatisierung", "/de/team", "/tr", "/tr/eski-sistem-modernizasyonu", "/tr/yapay-zeka-is-akisi-otomasyonu", "/tr/ekip"]) {
    assert.match(sitemap, new RegExp(`https:\\/\\/product\\.example\\.test${path === "/" ? "/" : path}`));
  }
  for (const path of ["/beta", "/privacy", "/impressum", "/terms", "/support", "/project"]) assert.doesNotMatch(sitemap, new RegExp(`<loc>https:\\/\\/product\\.example\\.test${path}<\\/loc>`));
  assert.match(sitemap, /xmlns:xhtml=/);
  assert.match(sitemap, /hreflang="de-DE"/);
  assert.match(sitemap, /hreflang="tr-TR"/);
  assert.match(sitemap, /hreflang="x-default"/);
  assert.match(sitemap, /<lastmod>2026-08-30<\/lastmod>/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /\.workflow-form/);
  assert.match(css, /\.v4-service-grid/);
  assert.match(css, /\.project-booking-hero/);
  assert.match(css, /\.project-type-options/);
  assert.match(css, /\.language-switcher/);
  assert.match(css, /\.team-profile/);
  assert.match(css, /\.field-grid\.two/);
});

test("personal beta remains available but is removed from commercial indexing", () => {
  const html = renderPublicSite("/beta", baseEnv, { host: "product.example.test" });
  assert.match(html, /<meta name="robots" content="noindex,follow">/);
  assert.match(html, /Start a private Orkestr workspace/);
});

test("every sitemap location renders a unique canonical public page", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.equal(locations.length, 32);
  assert.equal(new Set(locations).size, locations.length);
  for (const location of locations) {
    const path = new URL(location).pathname;
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, /<main id="main-content"/);
    assert.match(html, new RegExp(`rel="canonical" href="${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, /<h1[^>]*>[^<]+<\/h1>/);
  }
});
