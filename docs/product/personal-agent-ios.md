# Personal Agent iOS application

## Framework decision

Build the first-party iOS client in SwiftUI as a native application. Keep the
web application as a compatible parallel surface; do not embed it in a web
view as the mobile product.

| Concern | SwiftUI native | Web wrapper |
|---|---|---|
| Current web UI reuse | Reuse API contracts, vocabulary, design tokens, and interaction patterns; views are implemented natively. | Maximum HTML/CSS reuse, but introduces a second shell around the existing web shell and its responsive navigation. |
| Security | Narrow native API client, system authentication presentation, Keychain-backed session material when an auth contract is approved, and explicit control of cached data. | Browser cookies and JavaScript state complicate credential boundaries; native bridge and web content become one larger trust surface. |
| Push | Native notification permission and payload minimization can be designed explicitly. | Depends on a native wrapper bridge and still needs native push integration. |
| Offline | Native views can represent cached/stale/loading states and OS-protected local storage deliberately. | Offline behavior follows the web app's service worker/cache model and requires extra wrapper coordination. |

SwiftUI is recommended because ADR 0003 calls for a first-class native app.
The tradeoff is that product layout and accessibility need to be maintained in
two presentation layers; API schemas and design vocabulary remain shared.

## Initial navigation and layout

```text
Assistant
  Global conversation
  Grounded briefing (only persisted, attributable facts)
  Active work / needs attention / recent results

Projects
  Project list
  Project conversation
  Tasks | Repository | Data | Runs | Activity

Approvals / Attention
  Pending owner decisions, blocked work, provider/service status

History / Memory / Settings
  Conversation and run history | consented memory controls | app preferences
```

On a compact screen, the global conversation is the primary content and
work/attention summaries follow it vertically. Project tabs become a horizontal
scrollable picker with an accessible selected-state label. Desktop-size iPad
layouts may use a two-column conversation and work summary, never hiding a
blocked/offline status behind a tab.

```text
┌ Assistant ──────────────────────────── Status: available/degraded ┐
│ Global conversation                                                │
│ [history unavailable until a read contract exists]                  │
│ [owner-authenticated ingress composer → queued receipt]             │
├──────────────────────────────────────┬─────────────────────────────┤
│ Grounded briefing                    │ Needs attention             │
│ Active work                          │ Recent results              │
└──────────────────────────────────────┴─────────────────────────────┘

┌ Project: <owner-visible title> ────────────────────────────────────┐
│ Conversation | Tasks | Repository | Data | Runs | Activity          │
│ Selected panel, with explicit empty/loading/stale/error state        │
└─────────────────────────────────────────────────────────────────────┘
```

The first shell contains no fabricated counters, messages, briefing or
project data. Test fixtures are confined to the test target. A disabled
capability is shown as disabled; missing storage or unavailable local
inference is explicit degraded state. Stale results retain their timestamp and
are not presented as current.

## API and authentication boundary

The client uses the authenticated owner APIs in ADR 0002: capability,
projects, project detail, task creation/detail and lifecycle transition. These
are contract paths, not claims that every route already exists; the current
base implements capability only. ORK-561 ingress uses the exact owner route
`POST /api/personal-agent/messages` and its documented global/project scope,
optional idempotency key, control flags and receipt envelope. It records an inbound message;
it does not synchronously produce an assistant reply. The inbox consumer is a
runtime service, not an invented mobile HTTP route. There is not yet a
conversation-read API in this base, so the client never pretends to display
message history or a reply. Missing server routes are surfaced as unavailable.
The API client accepts an authenticated transport from the app boundary and
does not collect connector credentials or persist bearer values. Remote URLs
must use HTTPS; cleartext HTTP is accepted only for loopback development.

No native sign-in or token exchange is introduced here because the current
repository does not define a native owner-auth flow. The release path must
provide a supported system-browser authentication adapter before live account
use; it must not copy web cookies or accept credentials in URLs.

The feature shell is exposed only after a capability response confirms
`enabled:true`. If that confirmed enabled state is retained while offline, the
UI must label it stale; an unknown/offline state does not expose feature
navigation.

## Provisioning and Integration Hub placeholders

Project detail includes a provisioning panel with visible slots for its
GitHub repository, Jira project, OXRM workspace and WhatsApp conversation. It
does not display a synthetic provider status or blocker: those fields await the
ORK-563 contract. The Integration Hub placeholder names the ADR's layers
(plugin packages, connections, capabilities, global/project bindings and
resource instances) but does not connect, enable, provision or infer state; it
awaits ORK-566 field names and authenticated read contracts. These surfaces
introduce no endpoints and contain no fixture data in the product.

## Draft mobile threat model

- **Authentication/session:** only the existing authenticated owner context may
  call the API. Use a provider-approved system-browser flow and a narrowly
  scoped credential provider once its contract is defined. Keep access material
  out of logs, deep links, analytics and crash reports; logout/revocation must
  invalidate local session state. This PR has no sign-in route or token store.
- **Push privacy:** notifications are opt-in and generic by default (for
  example, “Orkestr has an update”). No message bodies, project names, task
  details, approval arguments or connector data appear on a locked screen.
  Fetch details only after authenticated app open.
- **On-device storage:** do not persist transcript or project data in this
  skeleton. Any later cache must have bounded retention, explicit purge on
  logout, iOS Data Protection while locked, and encryption at rest. Secrets
  use Keychain with the narrowest accessibility class; never UserDefaults,
  shared containers or logs.
- **Credential isolation:** connector passwords, OAuth refresh tokens and
  browser/session secrets remain server-side. The app receives only the
  minimum authenticated API session and opaque object references authorized by
  the server. Application controls do not isolate a root-capable runtime.
- **Effects and approvals:** the client may display and request an owner
  decision, but server policy and existing Agent Job approval/effect binding
  remain authoritative. A mobile UI state cannot authorize an effect by itself.

## Build and release

The proposed CI job uses a static GitHub-hosted `macos-14` runner, pinned
checkout action, `contents: read`, and unsigned simulator compilation/tests.
It does not use signing certificates, App Store Connect, TestFlight, secrets,
or a self-hosted runner. Distribution/signing is explicitly out of scope.
