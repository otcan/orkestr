# Commercial Site Architecture

## Host responsibilities

| Host | Responsibility |
| --- | --- |
| `orkestr.de` | Commercial evaluation, Workflow Audit qualification, public documentation links, and legal pages |
| `app.orkestr.de` | Authenticated Orkestr application and authorized application launcher |
| `connect.orkestr.de` | Secure pairing and connector authorization entry |

Private and self-hosted deployments configure equivalent hosts through the
existing public URL environment variables. The marketing host must never render
the instance chooser or private Angular cockpit.

## Route map

- `/`: managed AI workflow implementation homepage
- `/workflow`: Workflow Audit map with qualified scheduling handoff
- `/use-cases`: concrete process chains
- `/security`: isolation, scoped connections, controls, boundaries, limitations
- `/deployment`: managed isolated and customer-controlled models
- `/developers`: architecture, OSS core, quick start, and public-alpha limits
- `/beta`: preserved personal beta disclosure, consent, and waitlist
- `/impressum`, `/privacy`, `/terms`, `/acceptable-use`, `/data-deletion`, `/support`: stable
  legal and support routes

Desktop navigation prioritizes How It Works, Use Cases, Deployment, Security,
and Book a Workflow Audit. Mobile navigation exposes the same destinations
without horizontal scrolling. Developers, GitHub, documentation, legal links,
and the Client Portal live in the footer. The personal beta route remains
available for compatibility but is not linked from the commercial footer.

## Compatibility and redirects

- `/waitlist` redirects to `/beta#waitlist`.
- The legacy `/#waitlist` fragment is moved client-side to `/beta#waitlist`
  because fragments are not sent to the server.
- `/public` continues to render the canonical commercial homepage.
- Existing legal routes remain stable and linked in the footer.
- `/app` and other application routes remain the private Angular surface on
  application deployments; host-boundary checks prevent the commercial pages
  from leaking onto a configured private host.

Canonical and Open Graph URLs use `ORKESTR_PUBLIC_SITE_URL`. The footer Client Portal uses
`ORKESTR_PUBLIC_APP_URL`; secure pairing uses `ORKESTR_CONNECT_PUBLIC_URL` or
the configured public auth URL. The workflow map always submits to the
first-party `/api/public/workflow-leads` endpoint. A qualified response may
include `ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL`; the public page never exposes
that provider URL before qualification and does not depend on a scheduler to
capture an inquiry.

The public shell emits factual Organization and WebSite structured data.
Non-home commercial pages also emit BreadcrumbList data. Titles, descriptions,
canonical URLs, Open Graph fields, and Twitter fields are unique to each page.
