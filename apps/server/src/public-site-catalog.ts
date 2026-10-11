import type { PublicPage } from "./public-site-config.js";
import { customerPortalBuildPage } from "./public-site-build-customer-portal.js";
import { evidenceDeskPage } from "./public-site-evidence-desk.js";
import { workoutLogPage } from "./free-workout-log-page.js";

// Shared registry for the /builds and /free index pages.
//
// Each build or free product lives in its own module and registers exactly one
// entry below. An entry is only linked from the index once it has a `render`
// function; without one it is listed as "coming soon" and never linked.
//
// Rules for entries (public site):
// - Synthetic data only. Never present a build as a paid client case study.
// - `evidence` must describe what a visitor actually sees: a simulation, a
//   recorded/replayed run, or live execution in an isolated environment.
// - The rendered page should use `section` as its PublicPage id and set
//   `canonicalPath` to `path`.

export type PublicCatalogSection = "builds" | "free";
export type PublicCatalogStatus = "live" | "coming-soon";
export type PublicCatalogEvidence = "simulation" | "recorded" | "live-isolated";

export type PublicCatalogEntry = {
  section: PublicCatalogSection;
  slug: string;
  title: string;
  summary: string;
  status: PublicCatalogStatus;
  evidence?: PublicCatalogEvidence;
  render?: (env: NodeJS.ProcessEnv) => PublicPage;
};

export const publicCatalog: PublicCatalogEntry[] = [
  // SITE-2a: /builds/customer-portal
  {
    section: "builds", slug: "customer-portal", status: "live", evidence: "simulation",
    title: "B2B customer portal with approval rules",
    summary: "A buyer submits an order, stock and credit rules check it, exceptions pause for an approver, and the timeline and audit log update. Synthetic data, runs in your browser.",
    render: () => customerPortalBuildPage(),
  },

  // SITE-2b: /builds/evidence-desk
  {
    section: "builds", slug: "evidence-desk", status: "live", evidence: "simulation",
    title: "Evidence desk",
    summary: "Trace claims to synthetic source records, mark contradictions, record review decisions, and export a reproducible summary. Runs in your browser on a fictional topic; after the page loads it sends nothing back.",
    render: () => evidenceDeskPage(),
  },

  // SITE-4: /free/workout-log (route CSP and static files: free-products-static.ts)
  {
    section: "free", slug: "workout-log", status: "live",
    title: "Workout log",
    summary: "Log sets, reps, and weight, run a rest timer, and see your best set and volume trend. No account. After it loads, it sends nothing back: no analytics, no data uploads.",
    render: () => workoutLogPage(),
  },
];

export function publicCatalogPath(entry: Pick<PublicCatalogEntry, "section" | "slug">) {
  return `/${entry.section}/${entry.slug}`;
}

export function publicCatalogEntryIsLive(entry: PublicCatalogEntry) {
  return entry.status === "live" && typeof entry.render === "function";
}

export function publicCatalogEntries(section: PublicCatalogSection) {
  return publicCatalog.filter((entry) => entry.section === section);
}

export function publicCatalogEntryForPath(pathname = "") {
  const path = String(pathname || "").replace(/\/+$/, "");
  return publicCatalog.find((entry) => publicCatalogEntryIsLive(entry) && publicCatalogPath(entry) === path) || null;
}
