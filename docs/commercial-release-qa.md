# Commercial Site Release QA

Release scope: Homepage V2 managed Workflow Audit positioning, operational pain,
browser execution, human decision control, measurement, public-safe product
evidence, responsive design, and SEO foundations.

## Changed surfaces

- Homepage message, before-and-after process, managed implementation contract,
  browser-only system map, four workflow chains, approval case, five-step
  engagement, measurement baseline, Console proof, FAQ, and audit CTAs
- `/workflow` Workflow Audit map and post-submission scheduling handoff
- Security access comparison, evidence, data boundaries, and limitations
- Deployment options, rollout, responsibilities, and secure pairing explanation
- Practical finance, customer, revenue, and service use cases
- Developer architecture, public/private boundary, and quick start
- Unique metadata, canonical URLs, social fields, structured data, sitemap tests,
  and conversion analytics events
- Commercial footer, Impressum route, mobile header, responsive cards and flows, focus, contrast, overflow, and
  reduced-motion behavior

The authenticated app host, secure connect host, personal beta intake, legacy
connector authorization and private deployment overlays remain separate
surfaces. Commercial workflow leads and personal-beta waitlist entries use
separate records and endpoints.

## Pre-release evidence

| Gate | Result |
| --- | --- |
| Server build | Pass |
| Web production build | Pass; initial bundle 1.19 MB raw / 252.66 kB estimated transfer |
| Focused public site, static server, analytics, and workflow-lead suite | 49/49 pass |
| Browser render | Pass at 1440px and 390px across seven public routes; no horizontal overflow |
| Browser workflow submission | Pass; successful confirmation with no scheduler configured |
| Full CI test runner | Pass; 2,117 passed, 6 skipped, 0 failed |
| `npm run smoke` | Pass |
| `npm run oss:boundary-check` | Pass; 643 public files scanned |
| `git diff --check` | Pass |

The focused verification covers the changed commercial surfaces. Production
deployment checks remain release gates. Real WhatsApp delivery is
not selected because this change does not touch WhatsApp behavior and repository
policy makes that diagnostic optional.

## Route and conversion checks

Focused render and server tests cover `/`, `/workflow`, `/use-cases`,
`/security`, `/deployment`, `/developers`, and `/impressum`. They verify:

- one manager-readable H1 and a unique title and description per page
- canonical and social metadata
- factual Organization and WebSite structured data
- breadcrumbs on non-home pages
- the existing sitemap routes
- consistent `Book a workflow audit` CTAs
- presence of the bounded workflow form, consent, validation, and submission
  JavaScript
- first-party submission before any qualified scheduling handoff
- successful inquiry capture when scheduling is not configured
- allowlisted first-party conversion analytics without submitted process data

The workflow-lead endpoint validates, qualifies, stores, and notifies separately
from the personal-beta waitlist. It may return a configured scheduling URL only
for a qualified workflow.

## Responsive and accessibility checks

Automated contracts verify a global visible focus ring, semantic landmarks,
native details navigation, a 760-pixel narrow-layout breakpoint, no page-level
horizontal overflow, and reduced-motion handling. At the narrow breakpoint:

- the header exposes Workflow Audit booking inside the menu
- the request-to-result flow becomes vertical
- proof panels and walkthrough steps stack
- trust, access, evidence, responsibility, and use-case grids become one column
- use-case shortcuts remain horizontally scrollable inside their own region
- workflow-form and final CTA controls use the available width

Post-deployment verification must still exercise the public routes at desktop
and phone widths. Release signoff requires readable content, reachable keyboard
focus, no horizontal page overflow, a functional submission state, and no
pre-qualification scheduler exposure.

## Claims review

- The opening states the AI Operations Layer category, operating outcome,
  managed implementation, browser-only capability, private delivery model,
  and human-control boundary.
- Trust claims are limited to verifiable product behavior: private deployment
  options, approved connections, human approval, visible status and history,
  and the public open-source core.
- The product walkthrough is labelled as public-safe demo data next to the evidence.
- Limitations remain explicit but appear after the useful security explanation.
- No customer, founder, certification, compliance, benchmark, ROI, or universal
  integration claim is introduced.

## Rollback and post-launch checks

Use the release train's recorded prior release id:

```bash
orkestr rollback --to <previous-release-id>
```

After deployment, verify all seven commercial routes, the personal beta route,
the public app Keycloak sign-in, the public-app launcher boundary, and the
no-cookie private-API exposure gate. A scheduling button may appear after a
qualified submission only when `ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL` contains
the owner-approved event URL; otherwise the submission remains queued for
review. Roll back on
host crossover, private API exposure, broken application authentication,
unreadable responsive layout, failed workflow submission, or misleading
qualification state.
