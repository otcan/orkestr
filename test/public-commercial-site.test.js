import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";

const baseEnv = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};

test("commercial homepage sells a managed workflow audit and operating outcome", () => {
  const html = renderPublicSite("/", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Managed AI Workflow Automation &amp; AI Agents \| Orkestr<\/title>/);
  assert.match(html, /Your software stores the work/);
  assert.match(html, /Orkestr moves it forward/);
  assert.match(html, /Show us a repetitive process across your ERP, CRM, email/);
  assert.match(html, /Incoming customer request/);
  assert.match(html, /Order and account checked/);
  assert.match(html, /ERP updated and reply sent/);
  assert.match(html, />Book a workflow audit<\/a>/);
  assert.match(html, /data-event="book_audit_hero"/);
  assert.match(html, /We build the automation for you/);
  assert.match(html, /APIs when available/);
  assert.match(html, /The browser when they’re not/);
  assert.match(html, /Customer Order Exception #10452/);
  assert.match(html, /If the workflow does not improve the operation, it should not scale/);
  assert.match(html, /The difference is not the model/);
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

test("commercial detail pages keep plain-language headings, evidence, limitations, and unique metadata", () => {
  const expectations = [
    ["/security", "Private AI Workflow Security", "Your systems stay under your control", "What Orkestr can—and cannot—work with"],
    ["/deployment", "Private AI Deployment Options", "Choose where Orkestr runs", "Four steps from idea to live operation"],
    ["/use-cases", "AI Workflow Automation Use Cases", "Start with work your team repeats every week", "Invoice exception handling"],
    ["/developers", "Open-Source AI Workflow Orchestration", "Software you can inspect, run, and question", "Run the core locally"],
  ];

  for (const [path, title, heading, evidence] of expectations) {
    const html = renderPublicSite(path, baseEnv, { host: "product.example.test" });
    assert.match(html, new RegExp(`<title>${title} \\| Orkestr<\\/title>`));
    assert.match(html, new RegExp(heading));
    assert.match(html, new RegExp(evidence));
    assert.match(html, /Book a workflow audit/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, new RegExp(`rel="canonical" href="https:\\/\\/product\\.example\\.test${path}"`));
  }
});

test("sitemap and responsive CSS retain commercial routes and accessible progressive enhancement", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const css = renderPublicSiteCss();

  for (const path of ["/", "/workflow", "/security", "/deployment", "/use-cases", "/developers", "/impressum"]) {
    assert.match(sitemap, new RegExp(`https:\\/\\/product\\.example\\.test${path === "/" ? "/" : path}`));
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /\.workflow-form/);
  assert.match(css, /\.browser-section/);
  assert.match(css, /\.workflow-card-grid/);
  assert.match(css, /\.approval-card/);
  assert.match(css, /\.field-grid\.two/);
});
