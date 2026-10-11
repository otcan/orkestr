import { escapeHtml, type PublicPage } from "./public-site-config.js";
import {
  publicCatalogEntries,
  publicCatalogEntryIsLive,
  publicCatalogPath,
  publicNoCallsNotice,
  type PublicCatalogEntry,
  type PublicCatalogEvidence,
  type PublicCatalogSection,
} from "./public-site-catalog.js";

const evidenceLabels: Record<PublicCatalogEvidence, { label: string; text: string }> = {
  simulation: { label: "Simulation", text: "Runs in your browser against synthetic data. Nothing is executed on a real system." },
  recorded: { label: "Recorded run", text: "A replay of a real run, captured once with synthetic data. You watch what happened; nothing runs again." },
  "live-isolated": { label: "Live, isolated", text: "Actually executes now, in an isolated environment with synthetic data and no access to client systems." },
};

const entryCards = [
  { path: "/builds", label: "LIVE BUILDS", title: "See working software", text: "Explore systems we built to show how difficult ideas become working products. Each one says whether it is a simulation, a recorded run, or live execution.", link: "Explore live builds" },
  { path: "/free", label: "FREE PRODUCTS", title: "Use something useful", text: "Small vertical products you can use for free. Each page states its status before you start.", link: "See free products" },
  { path: "/open-source", label: "OPEN SOURCE", title: "Run your own agents", text: "Orkestr OSS: run your coding agent, leave your desk, and stay in control, on your own machine or VPS.", link: "Explore open source" },
  { path: "/studio", label: "STUDIO", title: "Build something serious", text: "For high-value software projects: we design, build, modernize, and operate custom systems with you.", link: "Visit the studio" },
];

// The studio is the only journey with German and Turkish pages.
const studioLanguages = '<p class="hub-languages">Also in <a href="/de/studio" hreflang="de-DE" lang="de">Deutsch</a> · <a href="/tr/studio" hreflang="tr-TR" lang="tr">Türkçe</a></p>';

function evidenceLegend() {
  const items = (Object.keys(evidenceLabels) as PublicCatalogEvidence[]).map((key) => `<div><dt><span class="hub-badge hub-evidence-${key}">${evidenceLabels[key].label}</span></dt><dd>${evidenceLabels[key].text}</dd></div>`).join("");
  return `<dl class="hub-evidence-legend">${items}</dl>`;
}

function catalogCard(entry: PublicCatalogEntry) {
  const live = publicCatalogEntryIsLive(entry);
  const status = live ? '<span class="hub-badge hub-status-live">Live</span>' : '<span class="hub-badge hub-status-soon">Coming soon</span>';
  const evidence = live && entry.evidence ? `<span class="hub-badge hub-evidence-${entry.evidence}">${evidenceLabels[entry.evidence].label}</span>` : "";
  const title = escapeHtml(entry.title);
  const heading = live ? `<a href="${publicCatalogPath(entry)}">${title}</a>` : title;
  return `<li class="hub-catalog-card${live ? "" : " is-pending"}"><div class="hub-badges">${status}${evidence}</div><h3>${heading}</h3><p>${escapeHtml(entry.summary)}</p>${live && entry.localOnly ? `<p class="hub-local-only">${publicNoCallsNotice}</p>` : ""}</li>`;
}

function catalogList(section: PublicCatalogSection) {
  const entries = publicCatalogEntries(section);
  const ordered = [...entries.filter(publicCatalogEntryIsLive), ...entries.filter((entry) => !publicCatalogEntryIsLive(entry))];
  return `<ul class="hub-catalog-grid">${ordered.map(catalogCard).join("")}</ul>`;
}

export function umbrellaHomePage(): PublicPage {
  const cards = entryCards.map((card) => `<li class="hub-entry-card"><p class="section-index">${card.label}</p><h3>${card.title}</h3><p>${card.text}</p><a class="text-link" href="${card.path}">${card.link} <span aria-hidden="true">→</span></a>${card.path === "/studio" ? studioLanguages : ""}</li>`).join("");
  return {
    id: "home",
    title: "We turn complex ideas into working software",
    summary: "Orkestr combines AI, software engineering, and business experience to turn difficult ideas into functioning systems. Explore live builds, free products, open source, and the studio.",
    canonicalPath: "/",
    body: `<main id="main-content" class="hub">
  <section class="hub-hero" aria-labelledby="home-title">
    <p class="eyebrow">AI · SOFTWARE · BUSINESS</p>
    <h1 id="home-title">We turn complex ideas into working software.</h1>
    <p class="lead">Orkestr combines AI, software engineering, and business experience to turn difficult ideas into functioning systems.</p>
    <div class="actions"><a class="button" href="/builds">Explore live builds</a><a class="button button-ghost" href="/studio">Discuss a project</a></div>
    <p class="microcopy">No account, upload, or form needed to look around.</p>
  </section>
  <section class="hub-section" aria-labelledby="ways-title">
    <div class="hub-section-head"><p class="section-index">WHERE TO START</p><h2 id="ways-title">Pick the way in that fits you.</h2></div>
    <ul class="hub-entry-grid">${cards}</ul>
  </section>
  <section class="hub-section" aria-labelledby="evidence-title">
    <div class="hub-section-head"><p class="section-index">HOW WE SHOW WORK</p><h2 id="evidence-title">Every demo says what it is.</h2><p>We label each build so you know exactly what you are looking at. Demos use synthetic data only and are not client case studies.</p></div>
    ${evidenceLegend()}
  </section>
</main>`,
  };
}

export function buildsIndexPage(): PublicPage {
  return {
    id: "builds",
    title: "Live builds",
    summary: "Working software built by Orkestr with synthetic data. Each build is labeled as a simulation, a recorded run, or live isolated execution.",
    canonicalPath: "/builds",
    body: `<main id="main-content" class="hub">
  <section class="hub-hero hub-hero-compact" aria-labelledby="builds-title">
    <p class="eyebrow">LIVE BUILDS</p>
    <h1 id="builds-title">Live builds</h1>
    <p class="lead">Systems we built to show how complex ideas turn into working software. They use synthetic data and are not client case studies.</p>
  </section>
  <section class="hub-section" aria-labelledby="builds-list-title">
    <div class="hub-section-head"><h2 id="builds-list-title">Builds</h2></div>
    ${catalogList("builds")}
  </section>
  <section class="hub-section" aria-labelledby="builds-evidence-title">
    <div class="hub-section-head"><p class="section-index">WHAT YOU ARE LOOKING AT</p><h2 id="builds-evidence-title">Simulation, recording, or live.</h2></div>
    ${evidenceLegend()}
    <p class="hub-next">Have a project of this kind? <a class="text-link" href="/studio">Visit the studio <span aria-hidden="true">→</span></a></p>
  </section>
</main>`,
  };
}

export function freeIndexPage(): PublicPage {
  return {
    id: "free",
    title: "Free products",
    summary: "Small, useful products by Orkestr that you can use for free. Each page states its status.",
    canonicalPath: "/free",
    body: `<main id="main-content" class="hub">
  <section class="hub-hero hub-hero-compact" aria-labelledby="free-title">
    <p class="eyebrow">FREE PRODUCTS</p>
    <h1 id="free-title">Free products</h1>
    <p class="lead">Small, focused products we build and give away. Each one states its status before you start.</p>
  </section>
  <section class="hub-section" aria-labelledby="free-list-title">
    <div class="hub-section-head"><h2 id="free-list-title">Products</h2></div>
    ${catalogList("free")}
  </section>
</main>`,
  };
}
