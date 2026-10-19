# Persistent API and finite execution windows

The beta server stays alive independently of its configured Codex Deep execution
window. This mode is selected explicitly through `ORKESTR_V2_BETA_CONFIG`,
exclusive with the existing execution-config and execution-set modes. It does
not select a provider, account, executable, workspace or credential from HTTP.
Legacy execution startup retains its current behavior.

## Browser boundary

The proposed runtime routes are authenticated `GET /api/v2/beta` and
`GET`/`POST /api/v2/conversations/:id/window`. Core supplies the request and
window status DTOs. The beta projection identifies only the configured
conversation and supported controls; it conveys no execution credential.

The client first uses existing durable message intake. Window admission binds
that exact message, accepted event and intake request key to an expected window
generation in Core's transaction. Failure between intake and admission leaves a
queued message. A current-window admission is explicit and does not create a new
window, budget or generation. Only Core's earliest admitted eligible input may
be claimed; a process-local FIFO filter is insufficient. Held inputs remain held.

## Opening and activation order

1. Core commits the opening and immutable input association before manager IPC.
2. The fixed root-owned manager acknowledges the exact owner, conversation,
   window, generation, boot identity and original absolute deadline.
3. Core issues the private one-use window credential using the current machine
   credential. The manager acknowledgement is not this credential.
4. The trusted factory binds the Store and prepares metadata using that private
   credential. Opening permits metadata preparation only.
5. Core activates the exact window last, before provider execution.
6. Runtime installs the matching local live handle. Every actual effect remains
   subject to Core's current credential, generation and window fence.

Manager IPC is one bounded canonical-JSON request/response over the fixed private
Unix socket. Its exact source contract must be pinned before wiring. It carries
no paths, programs, account selectors or execution tokens. Authentication binds
the actual Rust process identity; JSON identifiers alone are not authority.

## Lifetime, cleanup and uncertainty

The original 900-second, 32-attempt, 64-MiB budget includes a 30-second,
4-attempt, 1-MiB cleanup reserve. Normal work stops by the original 870-second
boundary and uses at most 28 attempts and 63 MiB. The root manager reserves
before forwarding, never refunds uncertainty, and owns its durable budget.
Runtime does not maintain a competing attempt counter or restart a deadline.

Running work uses existing issued Stop, genuine terminal evidence and original
owned-tree reap. Awaiting owner acceptance stays awaiting owner acceptance;
expiry, local exit and an ACK do not fabricate a terminal or acceptance.
Retirement uses the still-valid old credential and Core's exact terminal
retirement provenance. Only a sealed subsequent transition may replace it.

The local handle slot refuses overlapping installation, non-increasing
generation, stale removal, foreign scope and reuse after uncertainty. A selected
clone may outlive removal; Core's effect fences must still reject it. Local
handle removal, task return and resource counts neither close a durable window
nor authorize a replacement. Startup, task loss, callback or cleanup uncertainty
requires reconciliation and cannot silently reopen a budget.

## Ownership and qualification

Runtime owns the persistent task observer, local handle selection and HTTP
composition. Core owns durable admission, claim/effect fences and credentials.
The manager owns privileged launch and egress budget. Installation owns the
pinned service startup closure. The beta mode remains unavailable until these
source contracts and their composition are qualified. This document does not
claim an executed build, service or provider trial.

## Pre-native child binding

`PreparingCodex::open_window_retained` invokes its one-shot trusted bind callback
with `BrokerChildLocator` immediately after retaining the spawned broker and
before queuing `OpenOwnedSession` or waiting for the FD3 writer. The locator is
not authority. The service-specific fixed launcher must stop itself before
creating its Pump/native process. The authenticated manager independently checks
that stopped child, captures its original ownership, continues it, and ACKs.
The callback returns success only after that bounded ACK. Failure drops the
original metadata authority and quarantines/reaps its retained child; callers
must persist window uncertainty and never retry the consumed launch. Resume
uses the same callback and preserves grant-only FD4. Legacy constructors do not
invoke this gate and retain their existing behavior.

A synthetic stopped-child test covers locator acquisition without an FD handoff.
It does not qualify manager authentication, process replacement, or native launch.
An actual cold-restart oracle must terminate the original Rust process and start
an independent process against the same disposable home. Recreating a wrapper
while retaining Store/credential objects is insufficient evidence.
