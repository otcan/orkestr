import fs from "node:fs";
import path from "node:path";
import type { PublicPage } from "./public-site-config.js";

// Registry of live builds on the public site. Each entry states honestly how
// the build runs so catalog pages can label simulation vs replay vs live runs.
export type PublicBuildMode = "simulation" | "replay" | "live-isolated";

export type PublicBuild = {
  slug: string;
  path: string;
  title: string;
  summary: string;
  mode: PublicBuildMode;
  modeLabel: string;
  data: string;
  assets: Record<string, string>;
};

const buildAssetRoot = path.resolve(process.cwd(), "apps/server/public-builds");

export const publicBuilds: PublicBuild[] = [
  {
    slug: "evidence-desk",
    path: "/builds/evidence-desk",
    title: "Evidence desk",
    summary: "Add claims, attach evidence, mark contradictions, and see a transparent score and review queue. Export a summary as JSON or Markdown.",
    mode: "simulation",
    modeLabel: "In-browser simulation",
    data: "Fictional sample dataset; state stays in your browser",
    assets: {
      "evidence-desk-app.js": "text/javascript; charset=utf-8",
      "evidence-desk-state.js": "text/javascript; charset=utf-8",
      "evidence-desk.css": "text/css; charset=utf-8",
    },
  },
];

export function publicBuildAsset(pathname = "") {
  const match = /^\/builds\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(pathname);
  if (!match) return null;
  const build = publicBuilds.find((entry) => entry.slug === match[1]);
  const type = build?.assets[match[2]];
  if (!build || !type) return null;
  try {
    return { type, body: fs.readFileSync(path.join(buildAssetRoot, build.slug, match[2]), "utf8") };
  } catch {
    return null;
  }
}

const limitations = [
  "This is a demonstration, not a research tool. The sample topic, sources and numbers are invented.",
  "The score is a simple, documented heuristic. It does not judge whether a source is truthful.",
  "Nothing is sent to a server and no AI model is involved. Clearing site data or pressing Reset demo removes your changes.",
  "Please do not enter personal, confidential or health information; the demo is not built to protect it.",
];

export function evidenceDeskPage(): PublicPage {
  const assetBase = "/builds/evidence-desk";
  return {
    id: "evidence-desk",
    title: "Evidence desk — live build",
    summary: "A runnable in-browser demo for organising claims and evidence: score each claim, track contradictions, work a review queue and export a summary. Synthetic data only.",
    stylesheets: [`${assetBase}/evidence-desk.css`],
    moduleScripts: [`${assetBase}/evidence-desk-app.js`],
    analytics: false,
    body: `<main id="main-content" class="evidence-desk">
      <section class="ed-intro" aria-labelledby="ed-title">
        <p class="eyebrow">LIVE BUILD · IN-BROWSER SIMULATION</p>
        <h1 id="ed-title">Evidence desk</h1>
        <p class="lead">Organise claims and the evidence behind them. Attach sources, mark contradictions, see a score per claim, work through a review queue and export a summary.</p>
        <div class="ed-notice" role="note"><strong>Synthetic demo — nothing leaves your browser.</strong><p>The sample data describes an invented town's tool library. The app runs entirely in this page, keeps its state in your browser's local storage, makes no network requests and uses no AI model. It is not a client project.</p></div>
        <details class="ed-limits"><summary>Limitations</summary><ul>${limitations.map((item) => `<li>${item}</li>`).join("")}</ul></details>
      </section>
      <section class="ed-shell" aria-label="Evidence desk demo">
        <p id="ed-loading" class="ed-empty">Loading the demo…</p>
        <noscript><p class="ed-notice">This demo needs JavaScript. The scoring method is described below.</p></noscript>
        <div id="ed-app" hidden>
          <div class="ed-toolbar">
            <button type="button" id="ed-reset" class="button button-small button-outline">Reset demo</button>
            <button type="button" id="ed-export-json" class="button button-small button-ghost">Export JSON</button>
            <button type="button" id="ed-export-md" class="button button-small button-ghost">Export Markdown</button>
            <p id="ed-status" class="ed-status" role="status" aria-live="polite"></p>
          </div>
          <div class="ed-grid">
            <div>
              <section class="ed-panel" aria-labelledby="ed-queue-title">
                <div class="ed-panel-head"><h2 id="ed-queue-title">Review queue</h2><span id="ed-queue-count" class="ed-count"></span></div>
                <ol id="ed-queue" class="ed-queue"></ol>
              </section>
              <section class="ed-panel" aria-labelledby="ed-claims-title">
                <h2 id="ed-claims-title">Claims</h2>
                <form id="ed-add-claim" class="ed-form ed-add-claim" aria-label="Add claim">
                  <label class="ed-field"><span>New claim</span><input id="ed-new-claim" name="claim" maxlength="280" autocomplete="off" required></label>
                  <button type="submit" class="button button-small">Add claim</button>
                </form>
                <ul id="ed-claims" class="ed-claims"></ul>
              </section>
            </div>
            <section id="ed-detail" class="ed-panel" aria-labelledby="ed-detail-title"></section>
          </div>
        </div>
      </section>
      <section class="section ed-method" aria-labelledby="ed-method-title">
        <p class="section-index">HOW THE SCORE WORKS</p>
        <h2 id="ed-method-title">A transparent heuristic, not a verdict.</h2>
        <ul>
          <li>Each item weighs <code>strength × type</code>: weak 1, moderate 2, strong 3; primary record and measurement ×1, observation ×0.8, secondary report ×0.6, anecdote ×0.4.</li>
          <li>Score = <code>50 + 50 × (support − against) / (support + against + 2)</code>, from 0 to 100. With no evidence a claim sits at 50.</li>
          <li>A claim enters the review queue when it has contradicting evidence, a contradiction link to another claim, no evidence, a single source, or only weak evidence. Marking it reviewed clears it until its evidence or links change.</li>
        </ul>
      </section>
    </main>`,
  };
}
