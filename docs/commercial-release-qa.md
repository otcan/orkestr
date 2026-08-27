# Commercial Site Release QA

Release scope: plain-language commercial simplification, direct call booking,
credibility evidence, responsive redesign, and SEO foundations.

## Changed surfaces

- Homepage message, proof flow, trust evidence, FAQ, and booking CTAs
- `/workflow` direct scheduling handoff and concise email fallback
- Security access comparison, evidence, data boundaries, and limitations
- Deployment options, rollout, responsibilities, and secure pairing explanation
- Practical finance, customer, revenue, and service use cases
- Developer architecture, public/private boundary, and quick start
- Unique metadata, canonical URLs, social fields, structured data, sitemap tests,
  and booking analytics events
- Mobile header, responsive cards and flows, focus, contrast, overflow, and
  reduced-motion behavior

The authenticated app host, secure connect host, personal beta intake, legacy
commercial lead API, connector authorization, and private deployment overlays
remain separate surfaces.

## Pre-release evidence

| Gate | Result |
| --- | --- |
| Server build | Pass |
| Web production build | Pass; initial bundle 1.19 MB raw / 251.63 kB estimated transfer |
| Focused public site, static server, analytics, and legacy lead suite | 49/49 pass |
| Full CI test runner | 2,114 tests; 2,108 pass; 6 opt-in/environment skips; 0 failures |
| `npm run smoke` | Pass |
| `npm run oss:boundary-check` | Pass; 636 public files scanned |
| `git diff --check` | Pass |

The aggregate skips require opt-in or external infrastructure and are not failed
assertions against the commercial site. Real WhatsApp delivery is not selected
because this change does not touch WhatsApp behavior and repository policy makes
that diagnostic optional.

## Route and conversion checks

Focused render and server tests cover `/`, `/workflow`, `/use-cases`,
`/security`, `/deployment`, and `/developers`. They verify:

- one manager-readable H1 and a unique title and description per page
- canonical and social metadata
- factual Organization and WebSite structured data
- breadcrumbs on non-home pages
- the existing sitemap routes
- consistent `Book a 20-minute call` CTAs
- absence of the old workflow form, fields, and submission JavaScript
- direct use of a configured safe HTTP(S) scheduling URL
- concise public-contact fallback when scheduling is not configured
- allowlisted first-party booking analytics without submitted process data

The legacy lead endpoint remains available for compatibility and retains its
validation, storage, notification, and privacy tests. It is no longer called by
the rendered `/workflow` page.

## Responsive and accessibility checks

Automated contracts verify a global visible focus ring, semantic landmarks,
native details navigation, a 760-pixel narrow-layout breakpoint, no page-level
horizontal overflow, and reduced-motion handling. At the narrow breakpoint:

- the header exposes booking inside the menu
- the request-to-result flow becomes vertical
- proof panels and walkthrough steps stack
- trust, access, evidence, responsibility, and use-case grids become one column
- use-case shortcuts remain horizontally scrollable inside their own region
- booking and final CTA controls use the available width

Post-deployment verification must still exercise the public routes at desktop
and phone widths. Release signoff requires readable content, reachable keyboard
focus, no horizontal page overflow, and a truthful scheduling state.

## Claims review

- The opening describes the manager outcome before introducing a technical
  category.
- Trust claims are limited to verifiable product behavior: private deployment
  options, approved connections, human approval, visible status and history,
  and the public open-source core.
- The product walkthrough is labelled as illustrative next to the evidence.
- Limitations remain explicit but appear after the useful security explanation.
- No customer, founder, certification, compliance, benchmark, ROI, or universal
  integration claim is introduced.

## Rollback and post-launch checks

Use the release train's recorded prior release id:

```bash
orkestr rollback --to <previous-release-id>
```

After deployment, verify all six commercial routes, the personal beta route,
the public app Keycloak sign-in, the public-app launcher boundary, and the
no-cookie private-API exposure gate. A scheduling button may be called live only
when `ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL` contains the owner-approved event
URL; otherwise the page must show the configured email fallback. Roll back on
host crossover, private API exposure, broken application authentication,
unreadable responsive layout, or misleading booking state.
