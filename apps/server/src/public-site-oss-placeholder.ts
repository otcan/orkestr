import { escapeHtml, publicRepoUrl, type PublicPage } from "./public-site-config.js";

// Placeholder for /open-source. SITE-3 replaces this module with
// public-site-oss.ts (exporting `openSourcePage(env): PublicPage`) and switches
// the import in public-site.ts.
export function openSourcePage(env = process.env): PublicPage {
  const repo = publicRepoUrl(env);
  return {
    id: "open-source",
    title: "Orkestr open source",
    summary: "Orkestr OSS runs persistent coding agents on your own machine or VPS so you can leave your desk and stay in control.",
    canonicalPath: "/open-source",
    body: `<main id="main-content" class="hub">
  <section class="hub-hero hub-hero-compact" aria-labelledby="oss-title">
    <p class="eyebrow">OPEN SOURCE</p>
    <h1 id="oss-title">Run your coding agent, leave your desk, and stay in control.</h1>
    <p class="lead">Orkestr OSS runs persistent agents on a machine or VPS you control. The source, documentation, and tests are public.</p>
    <div class="actions"><a class="button" href="${escapeHtml(repo)}" rel="noreferrer">View on GitHub</a><a class="button button-ghost" href="/developers">Run the core locally</a></div>
  </section>
</main>`,
  };
}
