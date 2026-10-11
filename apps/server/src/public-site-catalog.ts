import type { PublicPage } from "./public-site-config.js";
import { workoutLogPage } from "./free-workout-log-page.js";

// Shared registry for the /free index page.
//
// Each free product lives in its own module and registers exactly one
// entry below. An entry is only linked from the index once it has a `render`
// function; without one it is listed as "coming soon" and never linked.
//
// Rules for entries (public site):
// - The rendered page should use `section` as its PublicPage id and set
//   `canonicalPath` to `path`.

// Owner-approved wording for pages that keep user entries in the browser.
// It promises no calls after load, not that the page is delivered offline.
// Only set `localOnly` when the page passes test/helpers/public-page-no-calls.mjs.
export const publicNoCallsNotice = "After this page loads, it sends nothing back: no analytics, no data uploads. Your entries stay in this browser.";

export type PublicCatalogSection = "free";
export type PublicCatalogStatus = "live" | "coming-soon";

export type PublicCatalogEntry = {
  section: PublicCatalogSection;
  slug: string;
  title: string;
  summary: string;
  status: PublicCatalogStatus;
  localOnly?: boolean;
  render?: (env: NodeJS.ProcessEnv) => PublicPage;
};

export const publicCatalog: PublicCatalogEntry[] = [
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
