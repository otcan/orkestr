import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { renderPublicSite, renderPublicSiteCss, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { ossCapabilityStatus, ossEvidenceLabels } from "../dist/server/apps/server/src/public-site-oss-status.js";

const env = {
  ORKESTR_PUBLIC_SITE_URL: "https://product.example.test",
  ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr",
};

function textOf(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

test("/open-source renders the OSS entry line, labelled simulation and real-provider path", () => {
  const html = renderPublicSite("/open-source", env, { host: "product.example.test" });
  assert.match(html, /<title>Orkestr Open Source: Persistent Agent Runtime \| Orkestr<\/title>/);
  assert.match(html, /<h1>Run your coding agent, leave your desk, and stay in control\.<\/h1>/);
  for (const fact of ["Persistent agent runtime", "Self-hosted", "No telemetry", "Provider-independent"]) assert.match(html, new RegExp(`<dt>${fact}</dt>`));
  assert.match(html, /SIMULATION<\/strong> <code>orkestr demo<\/code>/);
  assert.match(html, /# SIMULATION: simulated AI, fake code host, no real job\nnode apps\/cli\/bin\/orkestr-oss\.js demo --yes/);
  assert.match(html, /orkestr-oss\.js init my-jobs/);
  assert.match(html, /orkestr-oss\.js run my-jobs/);
  assert.match(html, /There is no public or hosted job runner here/);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/open-source"/);
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /<main[\s\S]*data-event=[\s\S]*<\/main>/, "the OSS page body adds no tracked click events");
  assert.doesNotMatch(html, /\son[a-z]+="/i, "no inline event handlers");
  assert.doesNotMatch(html, /<script[^>]+src=/i, "no third-party scripts");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs] of scripts) assert.match(attrs, /type="application\/ld\+json"/, "only inert structured data, no executable page code");
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, "no requests from page code after load");
  assert.doesNotMatch(html, /\/api\/public\/events|orkestrTrack/, "no analytics beacon (shell data-event markers stay inert without the script)");
  assert.match(html, /After this page loads, it sends nothing back: no analytics, no data uploads\./);
  assert.doesNotMatch(html, /Book a project call<\/a><\/section>/, "no consulting CTA on the OSS page body");
});

test("/open-source status table is rendered from the single data module with exact wording", () => {
  const html = renderPublicSite("/open-source", env, { host: "product.example.test" });
  const table = html.match(/<table class="oss-status-table">[\s\S]*?<\/table>/)?.[0] || "";
  assert.ok(table, "status table rendered");
  assert.equal((table.match(/<tr>/g) || []).length, ossCapabilityStatus.length + 1);
  const text = textOf(table);
  for (const row of ossCapabilityStatus) {
    assert.ok(text.includes(row.capability), row.capability);
    assert.ok(text.includes(row.status), row.status);
    assert.ok(text.includes(ossEvidenceLabels[row.evidence].label), row.evidence);
  }
  const status = Object.fromEntries(ossCapabilityStatus.map((row) => [row.capability, row]));
  assert.equal(status["Codex jobs"].status, "live-verified once on production build (approval pause -> approve -> single-use approval consumed, effect ledgered)");
  assert.equal(status["Codex jobs"].evidence, "live-verified");
  assert.match(status["Codex jobs"].note, /Codex CLI 0\.157\.1 job, approval-gated file change, live-verified once on release main-a343edf1ac91/);
  assert.match(status["Claude Code jobs"].note, /^Not working\./);
  assert.equal(status["Claude Code jobs"].status, "NOT supported yet (permission hook not enforced in live test; refused unless configured)");
  assert.notEqual(status["Claude Code jobs"].evidence, "live-verified");
  assert.equal(status["YAML/JSON job specs"].status, "verified");
  assert.equal(status["WhatsApp/email notifications"].status, "built, not live-verified");
  assert.notEqual(status["WhatsApp/email notifications"].evidence, "live-verified");
  assert.equal(status["Webhooks (HMAC)"].status, "built and tested offline");
  assert.equal(status["Webhooks (HMAC)"].evidence, "offline-tested");
  assert.equal(status["Guarantees G1-G11"].status, "tested with simulated/fake providers");
  assert.equal(status["Guarantees G1-G11"].evidence, "simulation");
});

test("/open-source links to the repository, quickstart and every spec file that exists", async () => {
  const html = renderPublicSite("/open-source", env, { host: "product.example.test" });
  assert.match(html, /href="https:\/\/github\.com\/otcan\/orkestr"/);
  const blobs = [...html.matchAll(/href="https:\/\/github\.com\/otcan\/orkestr\/blob\/main\/([^"]+)"/g)].map((match) => match[1]);
  const specs = (await fs.readdir("docs/spec")).filter((file) => file.endsWith(".md")).map((file) => `docs/spec/${file}`);
  for (const doc of ["docs/quickstart.md", ...specs]) assert.ok(blobs.includes(doc), `links ${doc}`);
  for (const doc of new Set(blobs)) await fs.access(doc);
});

test("README status table matches the public status data module", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  assert.match(readme, /Run your coding agent, leave your desk, and stay in control\./);
  const block = readme.match(/<!-- status:start[^>]*-->([\s\S]*?)<!-- status:end -->/)?.[1] || "";
  const rows = block.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Capability") && !line.startsWith("| ---"));
  assert.deepEqual(rows, ossCapabilityStatus.map((row) => `| ${row.capability} | ${row.status} | ${ossEvidenceLabels[row.evidence].label.toLowerCase()} |`));
});

test("/open-source is routed, in the sitemap, linked from the footer and styled", () => {
  assert.match(renderPublicSitemap(env), /<loc>https:\/\/product\.example\.test\/open-source<\/loc>/);
  assert.match(renderPublicSite("/", env, { host: "product.example.test" }), /<a href="\/open-source">Open source<\/a>/);
  assert.match(renderPublicSiteCss(), /\.oss-status-table/);
  assert.equal(renderPublicSite("/open-source", env, { host: "other.example.test" }), "");
});
