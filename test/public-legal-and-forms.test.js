import assert from "node:assert/strict";
import test from "node:test";
import { publicSiteKnownPath, renderPublicSite } from "../dist/server/apps/server/src/public-site.js";

const baseEnv = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
  ORKESTR_PUBLIC_CONTACT: "hello@example.test",
};
const host = { host: "product.example.test" };

// The marketing pages moved to a separate static site. The app keeps the
// legal and support pages, the OAuth homepage and the lead-form pages.
test("the app still serves legal, support, beta and lead-form pages on the public host", () => {
  for (const path of ["/terms", "/privacy", "/impressum", "/acceptable-use", "/data-deletion", "/support", "/beta", "/project", "/workflow", "/de/projekt", "/tr/proje", "/about"]) {
    assert.ok(publicSiteKnownPath(path), path);
    assert.match(renderPublicSite(path, baseEnv, host), /<html/, path);
  }
});

test("localized project pages keep a working short project form", () => {
  for (const path of ["/de/projekt", "/tr/proje"]) {
    const html = renderPublicSite(path, baseEnv, host);
    assert.match(html, /id="quick-project-form"/);
    assert.match(html, /\/api\/public\/project-inquiries/);
    for (const field of ["projectType", "desiredOutcome", "contactName", "workEmail", "consentToContact"]) assert.match(html, new RegExp(`name="${field}"`));
  }
});

test("marketing pages are no longer rendered by the app", () => {
  for (const path of ["/studio", "/free", "/free/workout-log", "/open-source", "/team", "/security", "/deployment", "/developers", "/use-cases", "/automation", "/de/studio", "/tr/ekip", "/public", "/sitemap.xml"]) {
    assert.equal(publicSiteKnownPath(path), false, path);
    assert.equal(renderPublicSite(path, baseEnv, host), "", path);
  }
});

test("the public host root is the OAuth homepage with privacy and terms links", () => {
  const html = renderPublicSite("/", baseEnv, host);
  assert.match(html, /<h1>Orkestr<\/h1>/);
  assert.match(html, /href="\/privacy">Privacy Policy/);
  assert.match(html, /href="\/terms">Terms of Service/);
  assert.doesNotMatch(html, /<script/);
});

test("public pages render only for the configured public host", () => {
  assert.equal(renderPublicSite("/project", baseEnv, { host: "other.example.test" }), "");
  assert.equal(renderPublicSite("/privacy", {}, { host: "localhost" }), "");
});

test("rendered pages carry no personal structured data", () => {
  const html = renderPublicSite("/project", baseEnv, host);
  assert.doesNotMatch(html, /"@type":"Person"/);
  assert.doesNotMatch(html, /assets\/site\//);
});

test("impressum uses the current Taraftech provider identity and DDG wording", () => {
  const html = renderPublicSite("/impressum", baseEnv, host);
  assert.match(html, /ANGABEN GEMÄẞ § 5 DDG/);
  assert.match(html, /Taraftech UG \(haftungsbeschränkt\)/);
  assert.match(html, /Herzogstraße 26, 66953 Pirmasens/);
  assert.match(html, /Oğuzcan Ünver/);
  assert.match(html, /HRB 31600, Amtsgericht Zweibrücken/);
  assert.match(html, /info@taraftech\.de/);
  assert.match(html, /Steuernummer: 35\/666\/00831/);
  assert.doesNotMatch(html, /§ 5 TMG|Online-Streitbeilegung|ec\.europa\.eu\/consumers\/odr/);
});

test("workflow route collects a bounded map before offering a scheduling handoff", () => {
  const html = renderPublicSite("/workflow", baseEnv, host);

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
  }, host);

  assert.match(html, /id="workflow-form"/);
  assert.doesNotMatch(html, /calendar\.example\.test/);
  assert.doesNotMatch(html, /Online scheduling is being connected/);
  assert.doesNotMatch(html, /mailto:/);
});

test("project route exposes direct booking and a four-answer adaptive alternative", () => {
  const html = renderPublicSite("/project", { ...baseEnv, ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL: "https://calendar.example.test/discovery" }, host);

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
  const html = renderPublicSite("/project", baseEnv, host);
  assert.match(html, /Request a project call/);
  assert.match(html, /href="#quick-project-form" data-event="project_call_request_click"/);
  assert.doesNotMatch(html, /calendar\.example\.test/);
});

test("personal beta remains available but is removed from commercial indexing", () => {
  const html = renderPublicSite("/beta", baseEnv, host);
  assert.match(html, /<meta name="robots" content="noindex,follow">/);
  assert.match(html, /Start a private Orkestr workspace/);
});
