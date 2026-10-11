import fs from "node:fs";
import path from "node:path";
import { escapeHtml, type PublicPage } from "./public-site-config.js";

// Registry of public live builds. Each entry must state honestly what kind of
// evidence it is: an in-browser simulation, a recorded replay, or live isolated execution.
export type PublicBuildEvidence = "simulation" | "recorded" | "live";

export type PublicBuild = {
  slug: string;
  path: string;
  title: string;
  summary: string;
  evidence: PublicBuildEvidence;
  evidenceNote: string;
};

export const publicBuildEvidenceLabels: Record<PublicBuildEvidence, string> = {
  simulation: "Simulation · runs in your browser",
  recorded: "Recorded replay",
  live: "Live isolated execution",
};

export const publicBuilds: PublicBuild[] = [
  {
    slug: "customer-portal",
    path: "/builds/customer-portal",
    title: "B2B customer portal with approval rules",
    summary: "A buyer submits an order, stock and credit rules check it, exceptions pause for an approver, and the timeline and audit log update.",
    evidence: "simulation",
    evidenceNote: "Synthetic data, rules and state run entirely in your browser. No server, no real orders.",
  },
];

const buildAssetDir = path.resolve(process.cwd(), "apps/server/public-builds");
const buildAssetTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const buildAssetFiles = new Set(["customer-portal/app.js", "customer-portal/workflow.js", "customer-portal/portal.css"]);

// Only an explicit allowlist of static demo files is served; never arbitrary paths.
export function readPublicBuildAsset(pathname = "") {
  const relative = String(pathname || "").replace(/^\/builds\//, "");
  if (!pathname.startsWith("/builds/") || !buildAssetFiles.has(relative)) return null;
  try {
    const body = fs.readFileSync(path.join(buildAssetDir, relative), "utf8");
    return { body, type: buildAssetTypes[path.extname(relative)] || "text/plain; charset=utf-8" };
  } catch {
    return null;
  }
}

export function buildsCatalogPage(): PublicPage {
  const cards = publicBuilds.map((build) => `<li>
        <span class="evidence-tag">${escapeHtml(publicBuildEvidenceLabels[build.evidence])}</span>
        <h2><a href="${build.path}">${escapeHtml(build.title)}</a></h2>
        <p>${escapeHtml(build.summary)}</p>
        <p class="portal-hint">${escapeHtml(build.evidenceNote)}</p>
        <a class="button button-small" href="${build.path}">Open the demo</a>
      </li>`).join("");
  return {
    id: "builds",
    title: "Live builds",
    summary: "Interactive, synthetic demos of systems Orkestr builds. Each build states whether it is a simulation, a recorded replay, or live isolated execution.",
    canonicalPath: "/builds",
    stylesheets: ["/builds/customer-portal/portal.css"],
    analytics: false,
    body: `<main id="main-content" class="build-page">
    <section class="build-hero">
      <p class="eyebrow">Live builds</p>
      <h1>Try working systems, not slides.</h1>
      <p class="lead">Each build is a bounded, synthetic demo you can use without an account. It is labelled with the kind of evidence it is, so you know what actually ran.</p>
    </section>
    <ul class="builds-list">${cards}</ul>
    <div class="build-ctas"><a class="button button-outline" href="/project">Discuss a project</a></div>
  </main>`,
  };
}
