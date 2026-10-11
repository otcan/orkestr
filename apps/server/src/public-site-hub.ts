import { escapeHtml, type PublicPage } from "./public-site-config.js";
import {
  publicCatalogEntries,
  publicCatalogEntryIsLive,
  publicCatalogPath,
  publicNoCallsNotice,
  type PublicCatalogEntry,
  type PublicCatalogSection,
} from "./public-site-catalog.js";

const entryCards = [
  { path: "/free", label: "FREE PRODUCTS", title: "Use something useful", text: "Small vertical products you can use for free. Each page states its status before you start.", link: "See free products" },
  { path: "/open-source", label: "OPEN SOURCE", title: "Run your own agents", text: "Orkestr OSS: run your coding agent, leave your desk, and stay in control, on your own machine or VPS.", link: "Explore open source" },
  { path: "/studio", label: "STUDIO", title: "Build something serious", text: "For high-value software projects: we design, build, modernize, and operate custom systems with you.", link: "Visit the studio" },
];

// The studio is the only journey with German and Turkish pages.
const studioLanguages = '<p class="hub-languages">Also in <a href="/de/studio" hreflang="de-DE" lang="de">Deutsch</a> · <a href="/tr/studio" hreflang="tr-TR" lang="tr">Türkçe</a></p>';

function catalogCard(entry: PublicCatalogEntry) {
  const live = publicCatalogEntryIsLive(entry);
  const status = live ? '<span class="hub-badge hub-status-live">Live</span>' : '<span class="hub-badge hub-status-soon">Coming soon</span>';
  const title = escapeHtml(entry.title);
  const heading = live ? `<a href="${publicCatalogPath(entry)}">${title}</a>` : title;
  return `<li class="hub-catalog-card${live ? "" : " is-pending"}"><div class="hub-badges">${status}</div><h3>${heading}</h3><p>${escapeHtml(entry.summary)}</p>${live && entry.localOnly ? `<p class="hub-local-only">${publicNoCallsNotice}</p>` : ""}</li>`;
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
    summary: "Orkestr combines AI, software engineering, and business experience to turn difficult ideas into functioning systems. Explore free products, open source, and the studio.",
    canonicalPath: "/",
    body: `<main id="main-content" class="hub">
  <section class="hub-hero" aria-labelledby="home-title">
    <p class="eyebrow">AI · SOFTWARE · BUSINESS</p>
    <h1 id="home-title">We turn complex ideas into working software.</h1>
    <p class="lead">Orkestr combines AI, software engineering, and business experience to turn difficult ideas into functioning systems.</p>
    <div class="actions"><a class="button" href="/free">Explore free products</a><a class="button button-ghost" href="/studio">Discuss a project</a></div>
    <p class="microcopy">No account, upload, or form needed to look around.</p>
  </section>
  <section class="hub-section" aria-labelledby="ways-title">
    <div class="hub-section-head"><p class="section-index">WHERE TO START</p><h2 id="ways-title">Pick the way in that fits you.</h2></div>
    <ul class="hub-entry-grid">${cards}</ul>
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
