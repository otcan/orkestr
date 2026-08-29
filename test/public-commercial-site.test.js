import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";

const baseEnv = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};

test("commercial homepage sells bounded business systems and managed operation", () => {
  const html = renderPublicSite("/", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Business Systems, Data &amp; AI Automation \| Orkestr<\/title>/);
  assert.match(html, /Tell us what your business needs to do/);
  assert.match(html, /We build the system that does it/);
  assert.match(html, /business software, data systems, and AI-powered automation/);
  for (const verb of ["BUILD", "REPLACE", "FIND", "COLLECT", "AUTOMATE"]) assert.match(html, new RegExp(`>${verb}<`));
  assert.match(html, /Bring us an ugly problem/i);
  assert.match(html, /Project Discovery/);
  assert.match(html, /Managed Operation/);
  assert.match(html, />Describe your project<\/a>/);
  assert.match(html, /data-event="describe_project_hero"/);
  assert.match(html, /APIs when available/);
  assert.match(html, /The browser when they are not/);
  assert.match(html, /id="requirement-example">“Our internal ordering system needs replacing\.”<\/blockquote>/);
  assert.match(html, /class="active" aria-pressed="true" data-requirement="Our internal ordering system needs replacing\.">Replace a system<\/button>/);
  assert.match(html, /Internal Ordering Renewal · Migration Run #042/);
  assert.match(html, /Record mapping conflict/);
  assert.match(html, /Not every project needs this layer/);
  assert.match(html, /Orkestr builds systems that do work/);
  assert.match(html, /public or authorized sources/i);
  assert.match(html, /Client Portal/);
  assert.doesNotMatch(html, /Personal beta/);
  assert.doesNotMatch(html, /Book a 20-minute call/);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/"/);
  assert.match(html, /"@type":"Organization"/);
  assert.match(html, /"@type":"WebSite"/);
  assert.doesNotMatch(html, /"@type":"BreadcrumbList"/);
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

test("project route collects a broad requirement before offering Discovery scheduling", () => {
  const html = renderPublicSite("/project", { ...baseEnv, ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL: "https://calendar.example.test/discovery" }, { host: "product.example.test" });

  assert.match(html, /<title>Describe Your Business System Project \| Orkestr<\/title>/);
  assert.match(html, /Tell us what your business needs to do/);
  assert.match(html, /id="project-form"/);
  assert.match(html, /\/api\/public\/project-inquiries/);
  assert.match(html, /projectType/);
  assert.match(html, /desiredOutcome/);
  assert.match(html, /systemsOrSources/);
  assert.match(html, /consentToContact/);
  assert.doesNotMatch(html, /calendar\.example\.test/);
  assert.match(html, /Only need workflow automation/);
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
    assert.match(html, /Describe your project/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, new RegExp(`rel="canonical" href="https:\\/\\/product\\.example\\.test${path}"`));
  }
});

test("solution pages are bounded, truthful, and preserve the specialized automation audit", () => {
  const expectations = [
    ["/websites-commerce", "Software first", "standard web technologies"],
    ["/business-systems", "Modernization without a blind rewrite", "staged migration"],
    ["/opportunity-intelligence", "Never manually search", "public or explicitly authorized"],
    ["/web-data-monitoring", "Scraping is a technique", "does not bypass access controls"],
    ["/automation", "Persistent work", "Book a Workflow Audit"],
  ];
  for (const [path, heading, boundary] of expectations) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(heading));
    assert.match(html, new RegExp(boundary));
    assert.match(html, /Describe your project/);
    assert.match(html, /Illustrative|BOUNDARIES|What Discovery must establish/);
  }
});

test("sitemap and responsive CSS retain commercial routes and accessible progressive enhancement", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const css = renderPublicSiteCss();

  for (const path of ["/", "/project", "/workflow", "/websites-commerce", "/business-systems", "/opportunity-intelligence", "/web-data-monitoring", "/automation", "/security", "/deployment", "/use-cases", "/developers", "/impressum"]) {
    assert.match(sitemap, new RegExp(`https:\\/\\/product\\.example\\.test${path === "/" ? "/" : path}`));
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /\.workflow-form/);
  assert.match(css, /\.browser-section/);
  assert.match(css, /\.offer-grid/);
  assert.match(css, /\.requirement-delivery/);
  assert.match(css, /\.approval-card/);
  assert.match(css, /\.field-grid\.two/);
});
