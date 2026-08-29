import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";

const baseEnv = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};

test("commercial homepage sells the managed AI operations layer and bounded workflow pilot", () => {
  const html = renderPublicSite("/", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Managed AI Operations Layer \| Orkestr<\/title>/);
  assert.match(html, /Your software stores the work/);
  assert.match(html, /Orkestr moves it forward/);
  assert.match(html, /coordinates persistent AI agents/);
  assert.match(html, /Request arrives/);
  assert.match(html, /Information is checked/);
  assert.match(html, /Manager approves/);
  assert.match(html, /Work is completed/);
  assert.match(html, />Map one workflow<\/a>/);
  assert.match(html, /data-event="map_workflow_hero"/);
  assert.match(html, /ORKESTR WORKFLOW PILOT/);
  assert.match(html, /WHAT THE PILOT INCLUDES/);
  assert.match(html, /One implemented workflow/);
  assert.match(html, /Measurement and rollout recommendation/);
  assert.doesNotMatch(html, /Book a 20-minute call/);
  assert.doesNotMatch(html, />ERP</);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/"/);
  assert.match(html, /"@type":"Organization"/);
  assert.match(html, /"@type":"WebSite"/);
  assert.doesNotMatch(html, /"@type":"BreadcrumbList"/);
});

test("workflow route collects a bounded map before offering a scheduling handoff", () => {
  const html = renderPublicSite("/workflow", baseEnv, { host: "product.example.test" });

  assert.match(html, /<title>Map an AI Workflow Pilot \| Orkestr<\/title>/);
  assert.match(html, /Map one workflow worth fixing/);
  assert.match(html, /A useful workflow map beats a generic demo call/);
  assert.match(html, /id="workflow-form"/);
  assert.match(html, /\/api\/public\/workflow-leads/);
  assert.match(html, /monthlyVolume/);
  assert.match(html, /workflowOwner/);
  assert.match(html, /consentToContact/);
  assert.match(html, /id="scheduling-handoff"/);
  assert.match(html, /qualified_schedule_click/);
  assert.match(html, />Send workflow for review<\/button>/);
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
    assert.match(html, /Map one workflow/);
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
  assert.match(css, /\.workflow-form/);
  assert.match(css, /\.pilot-offer/);
  assert.match(css, /\.field-grid\.two/);
});
