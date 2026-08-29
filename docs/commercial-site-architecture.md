# Commercial Site Architecture

## Host responsibilities

| Host | Responsibility |
| --- | --- |
| `orkestr.de` | Project evaluation, public solution pages, Project Discovery, technical links, and legal pages |
| `app.orkestr.de` | Authenticated Orkestr application and authorized application launcher |
| `connect.orkestr.de` | Secure pairing and connector authorization entry |

The marketing host must never render private application or instance state.

## Route map

- `/`: business systems and automation homepage
- `/use-cases`: BUILD · REPLACE · FIND · COLLECT · AUTOMATE overview
- `/websites-commerce`, `/business-systems`, `/opportunity-intelligence`,
  `/web-data-monitoring`, `/automation`: bounded solution pages
- `/project`: booking-first Project Discovery with an adaptive short brief
- `/workflow`: specialized Workflow Audit and qualified scheduling handoff
- `/security`, `/deployment`, `/developers`: evaluation detail
- `/beta`: preserved personal beta, intentionally absent from commercial nav
- `/impressum`, `/privacy`, `/terms`, `/acceptable-use`, `/data-deletion`,
  `/support`: stable legal and support routes

The header prioritizes What we build, Examples, How we work, Security, and Book
a project call. Developers, GitHub, documentation, deployment detail, legal
links, and Client Portal remain available through supporting routes or footer.

`POST /api/public/project-inquiries` stores Project Discovery separately from
workflow leads and beta waitlist records. Quick submissions require only project
type, desired outcome, contact name, work email, and consent; deeper context is
optional. A valid `ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL` is the direct
booking action and post-submit handoff. Without it, the quick form is the native
call-request fallback. Detailed legacy submissions retain readiness gating. The
specialized workflow form continues to use `/api/public/workflow-leads` and its
own qualified scheduler setting.

`/waitlist` and the legacy `/#waitlist` path continue to reach `/beta#waitlist`.
`/public` renders the canonical homepage. Canonical URLs, metadata, structured
data, sitemap generation, and host-boundary checks remain server controlled.
