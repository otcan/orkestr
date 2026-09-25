import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss } from "../dist/server/apps/server/src/public-site.js";
import { publicPagePath } from "../dist/server/apps/server/src/public-site-config.js";
import { renderSolutionFaq } from "../dist/server/apps/server/src/public-site-solution-faq.js";

const env = { ORKESTR_PUBLIC_SITE_URL: "https://product.example.test", ORKESTR_PUBLIC_APP_URL: "https://app.example.test" };
const services = ["websites-commerce", "business-systems", "opportunity-intelligence", "web-data-monitoring", "automation"];
const headings = { en: "Frequently asked questions", de: "Häufige Fragen", tr: "Sık sorulan sorular" };
const decode = value => value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");

for (const locale of ["en", "de", "tr"]) test(`${locale}: all five services have localized, accessible FAQs grounded in existing copy`, () => {
  const prompts = new Set();
  for (const id of services) {
    const route = publicPagePath(id, locale);
    const html = renderPublicSite(route, env, { host: "product.example.test" });
    const section = html.match(/<section class="section faq solution-faq"[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(section, route);
    assert.match(section, /aria-labelledby="solution-faq-title"/);
    assert.ok(section.includes(`<h2 id="solution-faq-title">${headings[locale]}</h2>`));
    assert.equal((html.match(/id="solution-faq-title"/g) || []).length, 1);
    const entries = [...section.matchAll(/<details><summary>([^<]+)<\/summary>((?:<p>[\s\S]*?<\/p>)+)<\/details>/g)];
    assert.equal(entries.length, 3, route);
    for (const [, question, answer] of entries) {
      assert.ok(!prompts.has(question), `service-specific question: ${question}`);
      prompts.add(question);
      // Every answer paragraph must already be in that service's approved
      // content, outside the new FAQ. No new customer or outcome claims.
      const approved = decode(html.replace(section, ""));
      for (const [, paragraph] of answer.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
        assert.ok(approved.includes(decode(paragraph)), `unapproved answer: ${paragraph}`);
      }
    }
    assert.doesNotMatch(section, /onclick|role="button"|tabindex=|aria-expanded=|<script/);
    assert.ok(html.indexOf(section) < html.lastIndexOf('class="final-cta compact"'));
    assert.ok(html.slice(html.indexOf(section)).includes(`href="${publicPagePath("project", locale)}#book"`));
    if (locale !== "en") assert.doesNotMatch(section, /Frequently asked questions|Does my website|Which sources|How does/);
  }
});

test("FAQs stay off the homepage and retain native disclosure, focus and mobile layout styling", () => {
  for (const locale of ["en", "de", "tr"]) {
    assert.doesNotMatch(renderPublicSite(publicPagePath("home", locale), env), /solution-faq-title/);
  }
  const css = renderPublicSiteCss();
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.solution-faq > \*\s*\{ min-width: 0; \}/);
  assert.match(css, /\.solution-faq summary, \.solution-faq p\s*\{ overflow-wrap: anywhere; \}/);
  assert.match(css, /@media[^}]*[\s\S]*?\.faq[^}]*\{ grid-template-columns: 1fr; \}/);
});

test("FAQ content is escaped as text and unsupported pages receive no service FAQ", () => {
  const unsafe = '<script>alert("fixture")</script>';
  const source = { id: "websites-commerce", proofText: unsafe, boundaries: [unsafe, unsafe, unsafe],
    stages: Array.from({ length: 4 }, () => ["Fixture", unsafe]) };
  const html = renderSolutionFaq(source);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;fixture&quot;\)&lt;\/script&gt;/);
  assert.equal(renderSolutionFaq({ ...source, id: "home" }), "");
});
