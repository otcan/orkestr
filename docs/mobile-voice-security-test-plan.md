# Hush mobile voice security test plan

This document defines the ORK-472 security and integration-test boundary for a
native Hush client. Hush is a separate mobile ingress. It must not reuse the
legacy Vagent static-token webhook or allow the client to select an Orkestr
thread.

The reusable black-box suite lives in
`test/support/mobile-voice-contract.js`. A MobileModule test supplies an HTTP
adapter and calls `registerMobileVoiceContractTests`. Test-only worker and clock
hooks are allowed; authentication and controller dispatch must go through the
real HTTP middleware.

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
  message ID.
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

The private profile binding is loaded from
`ORKESTR_OVERLAY_DIR/mobile-profiles.json` (or the explicit
`ORKESTR_MOBILE_PROFILES_FILE`) and requires `id`, `ownerUserId`, and
`threadId`. Real bindings belong only in the private overlay. A public-shaped
example is:

```json
{
  "profiles": [
    {
      "id": "hush-primary",
      "label": "Hush",
      "ownerUserId": "example-owner",
      "threadId": "example-thread"
    }
  ]
}
```

Revocation removes live sessions immediately. New requests and reconnects are
denied, and an already-open SSE checks the server-owned device/profile binding
on each poll and closes with a safe stream failure after revocation. The
background turn itself remains durable and is not cancelled by transport
closure.
