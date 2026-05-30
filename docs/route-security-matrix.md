# Orkestr Route Security Matrix

This matrix is the public OSS route ownership baseline. It separates
tenant-instance APIs, which operate on one local owner scope, from control-plane
APIs, which can see or mutate host-wide state and therefore require admin
authorization.

## Rules

- Public setup/bootstrap routes are limited to health, readiness, version,
  redacted setup status, browser pairing challenge creation/status, browser
  pairing, OAuth callbacks, desktop-share challenge links, and WhatsApp inbound
  when a configured machine token is accepted.
- Tenant-instance routes must use the request principal and enforce
  `ownerUserId` through scoped helpers before reading or mutating data.
- Control-plane routes require admin. Non-admin users receive
  `control_plane_admin_required` or a more specific admin-required error.
- WebSocket routes follow the same rules as polling routes. Summary streams use
  the request principal. Raw terminal streams are admin-only.
- Admin aggregation must redact or avoid private tenant data unless the route is
  explicitly an admin control-plane route.

## Matrix

| Surface | Route Examples | Access Rule | Enforcement |
| --- | --- | --- | --- |
| Health and version | `GET /api/health`, `GET /api/ready`, `GET /api/version` | Public bootstrap | `authorizeHttpRequest` before pairing |
| Setup status | `GET /api/setup/status` | Public bootstrap, redacted when unpaired or non-admin | `publicSetupStatus` |
| Browser pairing bootstrap | `POST /api/setup/security/challenge`, `GET /api/setup/security/challenges/:id`, `POST /api/setup/security/pair` | Public bootstrap | Pairing challenge state and expiry |
| Browser pairing administration | challenge list, approve, reject, delete, sessions, enable, revoke | Admin only | control-plane route guard |
| Threads list and summary | `GET /api/threads`, `GET /api/threads/summary` | Owner-scoped, admin can request all | `threadSummaryPayload` with principal |
| Thread summary WebSocket | `WS /api/threads/summary/stream` | Same scope as polling summary | WebSocket auth plus `threadSummaryPayload` principal |
| Thread read/write | messages, input, wake, stop, reset, delete, binding, timers | Current owner or admin | HTTP thread route guard plus scoped core helpers |
| Thread raw terminal | `WS /api/threads/:id/stream` | Admin only | WebSocket auth plus raw terminal admin guard |
| Thread workers and repo sync | workers, repo metadata, parent sync, attach terminal | Admin only | thread controller admin guards |
| Timers | `GET/POST/DELETE /api/timers`, run, doctor | Owner-scoped | timer principal helpers |
| Files and workspaces | `GET /api/files`, `GET /api/system/files`, workspace folders | Owner-scoped | workspace principal helpers and path containment |
| Browser desktops | browsers, browser sessions, leases, share links | Owner-scoped except share challenge bootstrap | browser and desktop lease principal helpers |
| Mail connectors | Gmail and Outlook OAuth/messages/tests | Owner-scoped | connector principal storage helpers |
| WhatsApp inbound | `POST /api/connectors/whatsapp/inbound` | Machine-token bootstrap or paired admin/user route target | inbound machine auth and router ownership |
| WhatsApp bridge administration | accounts, chats, QR, send, recover, deliver, config, overlay actions | Admin only | connector route guard |
| Users | `GET/POST/PATCH /api/users` | Admin only | users controller and control-plane guard |
| Tenant VM registry | `GET/POST/PATCH/DELETE /api/tenant-vms` | Admin only | tenant VM registry controller and control-plane guard |
| Codex host control | `GET /api/codex/*`, import, migrate | Admin only | control-plane guard |
| Agents and executors | `/api/agents`, `/api/executors`, `/api/executions` | Admin only | control-plane guard |
| Runtime leases and host system | runtime leases, system/processes/resources/doctor/settings | Admin only | control-plane guard |
| Agent context | `GET /api/whereiam` | Owner-scoped | `whereAmI` with principal and denied capability hints |

## Test Expectations

Every release that touches route ownership must include negative tests for
cross-tenant reads/writes, non-admin control-plane access, summary WebSocket
scope, raw terminal denial, connector administration denial, and scoped files or
workspace browsing.
