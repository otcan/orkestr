# Hush mobile voice security test plan

This document defines the ORK-472 security and integration-test boundary for a
native Hush client. Hush is a separate mobile ingress. It must not reuse the
legacy Vagent static-token webhook or allow the client to select an Orkestr
thread.

The reusable black-box suite lives in `test/support/mobile-voice-contract.js`
and defines the 17 scenarios in `mobileVoiceContractScenarios` (the Required
cases table below). It is activated with a real in-process HTTP adapter --
`createMobileVoiceHttpHarness` in `test/support/mobile-voice-http-harness.js`
-- registered at the top level of `test/mobile-voice-contract.test.js`:
`registerMobileVoiceContractTests({ test, createHarness:
createMobileVoiceHttpHarness })`. That call turns every one of the 17
scenarios into a genuine `node:test` case; none of them are stubs or a
registration-only check (a separate, narrower test in the same file still
checks that all 17 are registered by name, but the line above is what
actually runs them). The harness boots one real Orkestr HTTP server
(`startServer`) and reuses it across all 17 scenarios rather than starting
one per scenario. Its lifecycle is closed exactly once, via
`after(closeMobileVoiceHttpHarness)` at the test file's module top level --
not from inside a running scenario, which would scope the hook to that one
scenario and close the shared server right after it finishes, starving every
later scenario. Test-only worker and clock hooks are allowed; authentication
and controller dispatch always go through the real HTTP middleware.

## Authoritative controller contract

Every authenticated mobile controller must require:

```js
request.orkestrMachineAuth === "mobile_device"
request.orkestrMachineAuthContext === {
  principalKind: "mobile_device",
  routeKind: "hush_mobile",
  deviceId,
  profileId,
  threadId,
  ownerUserId,
}
```

The values are produced by verified device authentication. Controllers derive
the device, profile, thread, and owner only from this context. Body, path, and
query values cannot override them. The shared
MobileModule context guard returns only the server-owned binding fields and
fails closed for a missing or malformed context.

A bearer access token is not sufficient authentication. The HTTP middleware
must validate the request's device-key proof, freshness, and replay protection
before setting `orkestrMachineAuth`. Token-only and invalid-proof requests must
not dispatch a mobile controller.

## Endpoint coverage

The turn contract targets these stable routes:

- `POST /api/mobile/voice-turns`
- `GET /api/mobile/voice-turns/:id`
- `GET /api/mobile/voice-turns/:id/events`

`POST /api/mobile/voice-turns` accepts a closed body containing a UUID
`clientTurnId`, `transcript`, and `locale`. Its public turn uses `status`,
`answer`, `speech`, and a safe structured `error` when applicable. Pairing,
approval, challenge-proof, refresh, and revoke route names remain an
implementation interface. The adapter must exercise their eventual public HTTP
routes rather than call pairing storage directly.

## Required cases

| Case | Setup and action | Required assertion |
| --- | --- | --- |
| Pairing start | Start pairing without application authentication. | Success reveals no owner, user, profile, or thread data. |
| Unpaired | Sign a request with a known but unapproved device key. | 401/403/404 safe denial; controller observation count is unchanged. |
| Expired | Use a correctly signed request with an expired access credential. | Denied before controller dispatch. |
| Revoked | Reuse a correctly signed credential after its device is revoked. | Denied before controller dispatch. |
| Malformed proof | Corrupt the signature, signed path/body, nonce, or timestamp. | Denied before controller dispatch. |
| Token only | Send the valid bearer credential without device proof. | Denied before controller dispatch. |
| Rate limit | Repeatedly start pairing from one limiter key. | 429, safe error code, and positive `Retry-After`. No user/profile/thread data. |
| Immediate revocation | Make one valid request, revoke, then immediately reuse the issued credential. | The second request is denied without waiting for access-token expiry. |
| Auth context | Make a valid turn request and inspect the request at controller entry. | Exact `mobile_device`/`hush_mobile` context with server-bound identifiers. |
| Client-selected route | Supply another `profileId` and `threadId` in body and query. | 400 rejection or complete disregard; successful results remain on the authenticated binding. |
| Isolation | Create devices bound to two distinct profiles/threads and cross-read a turn and stream. | Uniform denial without turn, profile, or thread disclosure. |
| Idempotency | Concurrently POST identical `clientTurnId` and content twice, then reuse the ID with different content. | Identical retries identify one durable turn and one input; conflicting reuse returns a safe 409. |
| SSE replay | Disconnect after an event, finish the turn, reconnect with `Last-Event-ID`. | Only missed events replay, event IDs are stable, and the terminal event is delivered. |
| Final correlation | Complete two concurrent turns in reverse order. | Each final is linked to its own input message and answer text never crosses. |
| Long task | Disconnect the foreground SSE while a turn is working, then finish it. | Work is not cancelled; polling later returns the durable final. |
| Safe errors | Fail the worker with a private diagnostic string. | Durable/API error is bounded and public; no stack, path, credential, or internal diagnostic is returned. |
| Commands disabled | Submit `/stop` as recognized text. | It is enqueued as text with `commandProcessing: "disabled"`; no privileged action runs. |

The endpoint adapter's normalized turn exposes enough state to assert this
without binding the suite to a response envelope:

```text
id, state, clientTurnId, profileId, threadId,
inputMessageId, finalParentMessageId, text, speech, error
```

## Additional live-HTTP hardening tests

`test/mobile-voice-live-hardening.test.js` covers five cases the 17-scenario
contract above states abstractly but does not itself exercise at the exact
boundary named, each against the same real HTTP server/auth path as the
contract suite:

| Test | What it proves that the contract scenarios above do not |
| --- | --- |
| Two simultaneous POST voice-turn requests over real HTTP complete without cross-delivering answers | Uses a real `Promise.all` of two concurrent `POST /api/mobile/voice-turns` requests, not sequential awaits, and reads both turns back concurrently after completing them out of order. |
| A valid device bearer token and proof are rejected on owner-only mobile routes | A fully valid, correctly-signed device credential gets `403` from `GET /api/mobile/profiles`, `GET /api/mobile/devices`, `POST /api/mobile/profiles/:id/pairings/approve`, and `POST /api/mobile/devices/:id/revoke` -- proving a device credential can never reach an owner-only route, not just that an *unauthenticated* request is denied there. |
| A syntactically valid but never-issued bearer token is denied, distinctly from an expired or revoked one | A random, well-formed bearer token with a correctly self-signed proof that was never paired at all is denied and dispatches zero thread messages, as opposed to a token whose session existed and later expired or was revoked. |
| A consumed pairing challenge cannot be replayed even while the pairing is still approved | Isolates the pairing challenge's own single-use (`challengeConsumedAt`) guard from the separate pairing-status guard, which alone already blocks any second `complete` call once a pairing reaches `completed`. The test replays an already-consumed challenge against a pairing whose status is deliberately rolled back to `approved`, so only the nonce-consumption check is under test. |
| A real authenticated SSE disconnect while dispatch is still genuinely in flight does not cancel the turn | Gates the injected `requestThreadInputDelivery` dependency on a manually-resolved promise so "dispatch has started but not finished" is a controlled fact, not a timing guess, then opens a real authenticated SSE stream, reads the `queued` event, and disconnects while that gate is still unresolved -- proving disconnect during genuinely in-flight work does not cancel it, rather than only proving that a turn can be completed after a client happened to disconnect. |

The shared ES256 pairing/env fixtures both this file and
`test/mobile-devices.test.js` use live in
`test/support/mobile-device-fixtures.js` (`keyPair`, `signJwt`,
`timedClaims`, `setupMobileEnv`, `pairApprovedDevice`).

## Storage and lifecycle invariants

- `clientTurnId` is durable and unique within the authenticated device binding.
  The thread input should reuse the existing atomic `clientMessageId` dedupe
  path with a device namespace rather than implement a process-local check.
- A turn records `queued`, `working`, and exactly one terminal `final` or
  `failed` state. State changes and monotonically ordered event IDs are durable
  before being published to SSE.
- SSE is a view over durable turn events. Closing a socket never owns or
  cancels the worker. `Last-Event-ID` replay reads stored events strictly after
  the supplied cursor.
- A final is accepted only when it is an assistant `completed`/
  `final_answer` message whose `parentMessageId` equals that turn's input
  message ID, or when both messages on that same thread share the same
  non-empty canonical Codex/executor turn ID. Exact parent matching takes
  precedence; timestamps and latest-answer ordering are never correlation
  signals.
- Complete text is retained for the authenticated turn response. Speech is a
  deterministic, bounded rendering of that same final; it is not another model
  completion.
- Raw microphone audio, access/refresh credentials, proof signatures, and
  private failure details are neither persisted in turn/event records nor
  logged.

## Adapter rules

The contract adapter may normalize responses and expose observations, but it
must not make the system under test safer than production:

1. `createTurn`, `getTurn`, and `readEvents` cross real HTTP authentication and
   controller routing.
2. The controller observation is captured at entry and contains only
   `machineAuth` and `machineAuthContext`; it is not synthesized from the test
   fixture.
3. Paired-device fixtures use generated P-256 keys. Malformed and token-only
   modes change the actual request headers/proof.
4. `completeTurn`, `failTurn`, and clock advancement may be test hooks because
   they model asynchronous worker/storage behavior, not authorization.
5. Every test gets isolated storage and limiter state.

`test/support/mobile-voice-test-helpers.js` provides P-256 signing fixtures, an
incremental SSE decoder that tolerates split chunks, `Last-Event-ID` headers,
eventual assertions, and safe-error checks.

## Implemented MobileModule pairing and authentication contract

The native client uses these closed public routes:

- `POST /api/mobile/pairing/start`
- `GET /api/mobile/pairing/:pairingId/poll?pollToken=...`
- `POST /api/mobile/pairing/:pairingId/complete`
- `POST /api/mobile/session/refresh`

The authenticated owner UI uses `GET /api/mobile/profiles`,
`POST /api/mobile/profiles/:profileId/pairings/approve`,
`GET /api/mobile/devices`, and
`POST /api/mobile/devices/:deviceId/revoke`. Public pairing responses and owner
projections do not expose the private profile-to-thread or owner binding.

The device generates and retains a P-256 private key. Pairing completion and
every authenticated request carry an ES256 compact JWS. Authenticated and
refresh requests use `X-Orkestr-Device-Proof`; access requests also use a
Bearer access token. Request proofs bind `sid`, `did`, method, exact path and
query, and the SHA-256 hash of the raw JSON body. They bind the access token
with `ath`, or the refresh token with `rth`. A unique `jti`, numeric `iat` and
`exp`, and the route-specific audience are mandatory. Proof expiry may be at
most five minutes in the future, clock skew is bounded to 60 seconds, and a
replayed `jti` is denied.

Default lifetimes are ten minutes for pairing, two minutes for the approval
challenge, ten minutes for access, and 30 days for refresh. Refresh rotates both
credentials atomically, so the previous refresh and access credentials stop
working. Pairing start defaults to 12 creations per client in ten minutes,
three pending pairings per client, and 100 pending pairings globally. A limited
request returns `429` and a positive `Retry-After`.

The private profile binding is preferably stored through Orkestr secure input
under the global `hush-mobile-profiles` name. Existing deployments may instead
load `ORKESTR_OVERLAY_DIR/mobile-profiles.json` (or the explicit
`ORKESTR_MOBILE_PROFILES_FILE`). Each profile requires `id`, `ownerUserId`, and
`threadId`. The optional `mirrorRepliesToWhatsApp` flag defaults to `false`.
When explicitly enabled, completed Hush replies use the profile thread's
eligible WhatsApp binding and the normal durable, fenced connector outbox. The
mobile client still receives no connector, chat, owner, or thread identifiers.
Real bindings belong only in encrypted private state or the private overlay. A
public-shaped example is:

```json
{
  "profiles": [
    {
      "id": "hush-primary",
      "label": "Hush",
      "ownerUserId": "example-owner",
      "threadId": "example-thread",
      "mirrorRepliesToWhatsApp": true
    }
  ]
}
```

An administrator can persist that JSON without putting it in shell history:

```bash
printf '%s\n' '{"profiles":[{"id":"hush-primary","label":"Hush","ownerUserId":"example-owner","threadId":"example-thread","mirrorRepliesToWhatsApp":true}]}' \
  | orkestr secret set hush-mobile-profiles --global --stdin
```

Revocation removes live sessions immediately. New requests and reconnects are
denied, and an already-open SSE checks the server-owned device/profile binding
on each poll and closes with a safe stream failure after revocation. The
background turn itself remains durable and is not cancelled by transport
closure.
