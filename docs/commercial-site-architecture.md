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
- `/project`: general Project Discovery intake
- `/workflow`: specialized Workflow Audit and qualified scheduling handoff
- `/security`, `/deployment`, `/developers`: evaluation detail
- `/beta`: preserved personal beta, intentionally absent from commercial nav
- `/impressum`, `/privacy`, `/terms`, `/acceptable-use`, `/data-deletion`,
  `/support`: stable legal and support routes

The header prioritizes What we build, How we work, Orkestr, Deployment,
Security, and Describe your project. Developers, GitHub, documentation, legal
links, and Client Portal remain in the footer.

`POST /api/public/project-inquiries` stores Project Discovery separately from
workflow leads and beta waitlist records. It may return
`ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL` only after readiness checks. The URL
is never embedded in the page before submission. The specialized workflow form
continues to use `/api/public/workflow-leads` and its own scheduler setting.

`/waitlist` and the legacy `/#waitlist` path continue to reach `/beta#waitlist`.
`/public` renders the canonical homepage. Canonical URLs, metadata, structured
data, sitemap generation, and host-boundary checks remain server controlled.
