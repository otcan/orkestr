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

  assert.match(html, /<title>Business Systems &amp; Automation \| Orkestr<\/title>/);
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
  assert.match(html, /More than a hand-off/);
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
    assert.match(html, /Book a project call/);
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
  assert.match(css, /\.v4-service-grid/);
  assert.match(css, /\.project-booking-hero/);
  assert.match(css, /\.project-type-options/);
  assert.match(css, /\.field-grid\.two/);
});
