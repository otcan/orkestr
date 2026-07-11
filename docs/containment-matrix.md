# Orkestr Containment Matrix

Use this matrix for public, demo, customer, or otherwise untrusted Orkestr
users. The public isolation baseline is a dedicated tenant VM or tenant
instance. A same-host tenant local slice is a tenant instance with a dedicated
Unix service user, systemd resource limits, and per-owner roots; it is more
efficient than a VM but is not VM-equivalent for arbitrary untrusted code.
Shared-process checks are defense-in-depth only; they are useful guardrails,
but they are not the hard boundary for arbitrary code, connector state, browser
profiles, or user files.

## Baseline

- Hard boundary: one tenant VM or tenant instance per public user or customer.
- Shared-process policy: `ownerUserId`, scoped APIs, non-admin LLM sanitizer
  checks, contained runtime policy, and UI filtering are defense-in-depth.
- Fail-closed rule: non-admin flows must have an explicit owner and contained
  security profile before they can create threads, timers, connector state, or
  runtime work.
- Sanitizer rule: admin sessions skip the sanitizer. For non-admin users, the
  LLM sanitizer has no fallback. If it is unavailable, unclear, or denied, the
  action is blocked. User-scoped challenge creation, display, resend, and status
  requests may route through the sanitizer, but challenge approval, consumption,
  bypass, or forgery is denied.
- Runtime rule: `orkestr whereiam --json` is the source of truth for contained
  agents. Static `AGENTS.md` text cannot grant more access than `whereiam`.
- Skill rule: contained agents may only use skills listed in
  `whereiam.capabilities.enabledSkills`, and connector booleans must come from
  user-scoped tenant instance state instead of host accounts.

## Matrix

| Surface | Hard Boundary | Defense-In-Depth Checks | Required Tests |
| --- | --- | --- | --- |
| Threads and messages | Tenant VM or tenant instance | `ownerUserId` on thread and message records, scoped list/get/delete/input APIs, one-thread default limit for non-admin users | Non-admin cannot see, enqueue to, delete, or duplicate another owner's thread |
| Files, uploads, temp files, and artifacts | Tenant VM filesystem or local slice per-owner roots | Per-user workspace roots, path traversal denial, no direct reads from global secrets or overlays | Non-admin file browser stays inside owned workspace and files roots |
| Code execution and Codex runtime | Tenant VM runtime or local slice service user | Workspace-write sandbox, on-request approvals, contained developer policy, host-skill denial | Non-admin thread creation cannot request root-trusted or danger-full-access runtime |
| `whereiam` and agent context | Tenant VM or local slice runtime metadata | Server-owned contained policy path, user skill registry capability hints, no admin paths for contained users | Contained `whereiam` reports tenant boundary, denied host skills, enabled/disabled skill lists, and policy metadata |
| Connectors | Tenant-owned instance state | Per-user Gmail/Outlook tokens, scoped setup status, user skill registry gates connector use, no global connector account listing | User A cannot read User B connector status, token state, connector errors, or disabled connector skills |
| WhatsApp routing | Tenant-owned WhatsApp account or generated group | External identity maps to one user, debug footer suppression for users, sanitizer failure notification | Generated WA user gets scoped thread and cannot appear in default admin chat list |
| Browser desktops | Tenant-owned browser profile | Per-user browser profile roots, desktop lease ownership, share links scoped to owner | User A cannot list, lease, restart, or share User B desktop |
| Timers | Tenant VM scheduler state | Timer `ownerUserId`, scoped doctor/list/run/delete APIs, sanitizer gate for prompt execution | Non-admin timer create/run fails closed without sanitizer and cannot target other owner |
| APIs and WebSockets | Tenant VM ingress or local slice instance ingress | Principal-aware route guards, server-side owner checks, no client-only filtering | Cross-tenant REST calls return forbidden or empty results |
| Release regression | Tenant VM or local slice deployment | Tenant isolation suite, release regression runner, post-deploy interruption scan | Every release that touches these surfaces runs `npm run test:tenant-isolation` |

## Review Rule

If a new feature exposes arbitrary code, connector credentials, browser state,
or user files to a public/non-admin user, the feature must either run inside the
tenant VM boundary or stay disabled for that user. Adding an `ownerUserId` check
alone is not enough for public isolation.
