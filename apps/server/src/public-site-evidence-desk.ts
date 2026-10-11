import type { PublicPage } from "./public-site-config.js";

// SITE-2b: /builds/evidence-desk. Server-rendered shell only; the interactive
// app is static JS under apps/server/public-builds/evidence-desk and runs fully
// in the browser (see public-site-build-assets.ts).
const limitations = [
  "This is a demonstration, not a research tool. The topic, source records and numbers are invented.",
  "The rubric score is an illustrative teaching device. It is not calibrated, not statistical and not a scientific confidence measure, and it cannot tell whether a source is true.",
  "The page and its scripts are delivered like any web page. After it loads, it sends nothing back: no analytics, no data uploads, and no AI model is involved. Clearing site data or pressing Reset demo removes your entries.",
  "Please do not enter personal, confidential or health information; the demo is not built to protect it.",
];

export function evidenceDeskPage(): PublicPage {
  const assetBase = "/builds/evidence-desk";
  return {
    id: "builds",
    canonicalPath: "/builds/evidence-desk",
    title: "Evidence desk — live build",
    summary: "A runnable in-browser demo on a fictional topic: trace evidence to synthetic source records, track contradictions, record review decisions and export a reproducible summary.",
    stylesheets: [`${assetBase}/evidence-desk.css`],
    scripts: [`${assetBase}/evidence-desk-app.js`],
    body: `<main id="main-content" class="evidence-desk">
      <section class="ed-intro" aria-labelledby="ed-title">
        <p class="eyebrow">LIVE BUILD · IN-BROWSER SIMULATION · FICTIONAL DATA</p>
        <h1 id="ed-title">Evidence desk</h1>
        <p class="lead">Organise claims and the evidence behind them. Trace every item to a source record, mark contradictions, record review decisions and export a summary that is byte-for-byte reproducible.</p>
        <div class="ed-notice" role="note">
          <strong>Fictional topic, synthetic records.</strong>
          <p>The sample data is about the <em>Brindlemere Tool Library</em>, an invented community lending service in an invented town. Every claim, source record, quote and number was written for this demo. Nothing describes a real person, organisation or client project.</p>
          <p class="ed-privacy">After this page loads, it sends nothing back: no analytics, no data uploads. Your entries stay in this browser (local storage). No AI model is involved.</p>
        </div>
        <details class="ed-limits"><summary>Limitations</summary><ul>${limitations.map((item) => `<li>${item}</li>`).join("")}</ul></details>
      </section>
      <section class="ed-shell" aria-label="Evidence desk demo">
        <p id="ed-loading" class="ed-empty">Loading the demo…</p>
        <noscript><p class="ed-notice">This demo needs JavaScript. The rubric is described below.</p></noscript>
        <div id="ed-app" hidden>
          <div class="ed-toolbar">
            <button type="button" id="ed-reset" class="button button-small button-outline">Reset demo</button>
            <button type="button" id="ed-export-json" class="button button-small button-ghost">Export JSON</button>
            <button type="button" id="ed-export-md" class="button button-small button-ghost">Export Markdown</button>
            <label class="ed-actor"><span>Acting as</span><select id="ed-actor"><option>You (this browser), as analyst</option><option>You (this browser), as reviewer</option></select></label>
            <p class="ed-checksum-line">Export checksum <code id="ed-checksum"></code></p>
            <p id="ed-status" class="ed-status" role="status" aria-live="polite"></p>
          </div>
          <datalist id="ed-source-options"></datalist>
          <div class="ed-grid">
            <div>
              <section class="ed-panel" aria-labelledby="ed-queue-title">
                <div class="ed-panel-head"><h2 id="ed-queue-title">Review queue</h2><span id="ed-queue-count" class="ed-count"></span></div>
                <ol id="ed-queue" class="ed-queue"></ol>
              </section>
              <section class="ed-panel" aria-labelledby="ed-claims-title">
                <div class="ed-panel-head"><h2 id="ed-claims-title">Claims</h2><span class="ed-count">Fictional</span></div>
                <form id="ed-add-claim" class="ed-form ed-add-claim" aria-label="Add claim">
                  <label class="ed-field"><span>New claim</span><input id="ed-new-claim" name="claim" maxlength="280" autocomplete="off" required></label>
                  <button type="submit" class="button button-small">Add claim</button>
                </form>
                <ul id="ed-claims" class="ed-claims"></ul>
              </section>
            </div>
            <section id="ed-detail" class="ed-panel" aria-labelledby="ed-detail-title"></section>
          </div>
          <section class="ed-panel ed-sources-panel" aria-labelledby="ed-sources-title">
            <div class="ed-panel-head"><h2 id="ed-sources-title">Source records</h2><span id="ed-source-count" class="ed-count"></span></div>
            <p class="ed-evidence-meta">Every evidence item links here. All records are synthetic and exist only inside this demo.</p>
            <ul id="ed-sources" class="ed-sources"></ul>
          </section>
        </div>
      </section>
      <section class="section ed-method" aria-labelledby="ed-method-title">
        <p class="section-index">HOW THE RUBRIC WORKS</p>
        <h2 id="ed-method-title">An illustrative rubric, not scientific confidence.</h2>
        <p>The score shows how a team could make its weighting rules explicit. It is not calibrated against outcomes, not a probability and not a measure of scientific confidence.</p>
        <ul>
          <li>Each item weighs <code>strength × type</code>: weak 1, moderate 2, strong 3; primary record and measurement ×1, observation ×0.8, secondary report ×0.6, anecdote ×0.4.</li>
          <li>Rubric score = <code>50 + 50 × (support − against) / (support + against + 2)</code>, from 0 to 100. With no evidence a claim sits at 50.</li>
          <li>A claim enters the review queue when it has contradicting evidence, a contradiction link, no evidence, a single source record, only weak evidence, or a reviewer asked for more evidence. Accepting or rejecting it clears it; any later change to its text, evidence or links reopens it. Every step is written to the claim's decision history with a UTC timestamp, the acting role and the exact before → after values.</li>
          <li>Exports are a pure function of the data: history timestamps are part of the data, but nothing is added at export time (no export date, browser or locale details). The same data always produces the same bytes and the same checksum.</li>
        </ul>
      </section>
    </main>`,
  };
}
