import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";

const baseEnv = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};

test("commercial homepage uses plain language, consistent booking CTAs, and factual SEO metadata", () => {
  const html = renderPublicSite("/", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Reliable AI Workflow Automation \| Orkestr<\/title>/);
  assert.match(html, /<h1>Make repetitive work run reliably\.<\/h1>/);
  assert.match(html, /Orkestr connects the tools your team already uses/);
  assert.match(html, /Request arrives/);
  assert.match(html, /Information is checked/);
  assert.match(html, /Manager approves/);
  assert.match(html, /Work is completed/);
  assert.match(html, />Book a 20-minute call<\/a>/);
  assert.match(html, /data-event="book_call_hero"/);
  assert.doesNotMatch(html, /Map one workflow/);
  assert.doesNotMatch(html, />ERP</);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/"/);
  assert.match(html, /"@type":"Organization"/);
  assert.match(html, /"@type":"WebSite"/);
  assert.doesNotMatch(html, /"@type":"BreadcrumbList"/);
});

test("workflow route removes qualification intake and uses the configured scheduler directly", () => {
  const html = renderPublicSite("/workflow", {
    ...baseEnv,
    ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL: "https://calendar.example.test/orkestr/20-minute-call?secret=ignored",
  }, { host: "product.example.test" });

  assert.match(html, /<title>Book a 20-Minute Workflow Call \| Orkestr<\/title>/);
  assert.match(html, /Let’s talk about the work you want to simplify/);
  assert.match(html, /data-booking-configured="true"/);
  assert.match(html, /href="https:\/\/calendar\.example\.test\/orkestr\/20-minute-call"/);
  assert.match(html, /target="_blank" rel="noreferrer"/);
  assert.match(html, /Email hello@example\.test/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /workflow-form/);
  assert.doesNotMatch(html, /workflow-leads/);
  assert.doesNotMatch(html, /monthlyVolume|workflowOwner|consentToContact/);
  assert.match(html, /"@type":"BreadcrumbList"/);
});

test("workflow route falls back to a concise booking email when no safe scheduler is configured", () => {
  const html = renderPublicSite("/workflow", baseEnv, { host: "product.example.test" });

  assert.match(html, /data-booking-configured="false"/);
  assert.match(html, /Online scheduling is being connected/);
  assert.match(html, /mailto:hello@example\.test\?subject=Orkestr%2020-minute%20call/);
  assert.doesNotMatch(html, /Qualification before scheduling/i);
  assert.doesNotMatch(html, /generic demo call/i);
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
    assert.match(html, /Book a 20-minute call/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, new RegExp(`rel="canonical" href="https:\\/\\/product\\.example\\.test${path}"`));
  }
});

test("sitemap and responsive CSS retain commercial routes and accessible progressive enhancement", () => {
  const sitemap = renderPublicSitemap(baseEnv);
  const css = renderPublicSiteCss();

  for (const path of ["/", "/workflow", "/security", "/deployment", "/use-cases", "/developers"]) {
    assert.match(sitemap, new RegExp(`https:\\/\\/product\\.example\\.test${path === "/" ? "/" : path}`));
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow-x: hidden/);
  assert.doesNotMatch(css, /\.workflow-form/);
});
