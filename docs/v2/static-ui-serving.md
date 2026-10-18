# Optional same-origin UI snapshot

Source-only proposal. Set ORKESTR_V2_UI_DIST explicitly to an absolute trusted
UI build directory containing index.html. There is no default distribution path.
No new dependency, CORS permission or origin/auth change is introduced. Browser
requests continue using relative /api/v2 URLs on the server origin.

Startup loads an immutable snapshot: at most 4096 supported assets, 8 MiB per
asset, 64 MiB total and 16 directory levels. Configure only a dedicated public
build directory, never a home, data or secret directory; assets are public.
Operator owns the directory and must prevent concurrent modification during load.
Symlinks/nonregular entries, dot names, percent/backslash names and API-namespaced
assets are rejected. Unknown asset extensions are ignored. Existing startup
behavior remains API-only when the setting is absent.

Only GET/HEAD serve exact assets; / maps to index.html. No SPA route fallback,
including for unknown /api routes, which retain JSON 404. Existing API routes and
auth remain intact. Traversal/percent-encoded paths are rejected, content types
are allowlisted and responses carry nosniff/no-store. Runtime requests perform
no filesystem lookup. This is not cookie/CSRF acceptance or complete UI acceptance.

Validation: pinned rustfmt and diff check only; three response tests authored,
not executed. Cargo/downloads remain held; root/lock/CI unchanged. Independent
review must verify Axum fallback composition, API middleware/auth preservation,
filesystem rejection and browser assets after coordinated build admission.
