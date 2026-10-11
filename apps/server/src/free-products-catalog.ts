import type { PublicPage } from "./public-site-config.js";
import { escapeHtml } from "./public-site-config.js";

export type FreeProduct = {
  slug: string;
  path: string;
  title: string;
  summary: string;
  facts: string[];
};

// Free products are standalone tools: no account, no upload, no lead form.
export const freeProducts: FreeProduct[] = [
  {
    slug: "workout-log",
    path: "/free/workout-log",
    title: "Workout log",
    summary: "Log exercises, sets, reps, and weight, run a rest timer, and see your best set and volume trend per exercise.",
    facts: ["Stays in your browser", "Export and import as JSON", "Works offline after the first visit"],
  },
];

function productCard(product: FreeProduct) {
  const facts = product.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("");
  return `<article class="v4-service-card free-product-card" id="${escapeHtml(product.slug)}"><span>Free · no signup</span><h3>${escapeHtml(product.title)}</h3><p>${escapeHtml(product.summary)}</p><ul>${facts}</ul><a href="${escapeHtml(product.path)}">Open ${escapeHtml(product.title.toLowerCase())} <span aria-hidden="true">→</span></a></article>`;
}

export function freeProductsPage(): PublicPage {
  return {
    id: "free-products",
    title: "Free Products",
    summary: "Free, useful tools from Orkestr that run in your browser. No account, no tracking, and your data stays on your device.",
    canonicalPath: "/free",
    analytics: false,
    body: `<main id="main-content"><section class="page-hero"><p class="section-index">Free products</p><h1>Useful tools you can use right away</h1><p class="lead">Each tool runs in your browser. There is no account, no tracking, and no form; what you enter stays on your device unless you export it yourself.</p></section><section class="section" aria-label="Available tools"><div class="v4-service-grid free-product-grid">${freeProducts.map(productCard).join("")}</div></section></main>`,
  };
}
