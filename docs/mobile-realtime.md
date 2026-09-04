# Hush Mobile Realtime

Hush Realtime is an authenticated WebRTC gateway. The phone sends an SDP offer to Orkestr; Orkestr creates the provider call, owns its sideband controller, and returns only the SDP answer and safe local call state. Profile ownership and the bound thread remain server-only.

## Routes

All routes require the existing Bearer access token and `X-Orkestr-Device-Proof` unless documented as a pairing bootstrap route.

```text
GET    /api/mobile/realtime
POST   /api/mobile/realtime/calls
GET    /api/mobile/realtime/calls/:callId
GET    /api/mobile/realtime/calls/:callId/events
DELETE /api/mobile/realtime/calls/:callId
PUT    /api/mobile/push-token
PUT    /api/mobile/live-activity-token
```

Call creation accepts only `clientCallId` and `offerSdp`. It is idempotent within the exact mobile session and rejects reuse with a different SDP. The event stream supports `Last-Event-ID` replay with a cursor local to the call.

The provider can invoke only `orkestr_start_task({request})` and `orkestr_get_task_status({taskId})`. The dispatcher rechecks the call, device, session, profile, owner, and thread binding and never accepts a routing identifier from provider output or the phone.

## Realtime configuration

Realtime stays disabled unless all required settings exist:

```text
ORKESTR_MOBILE_REALTIME_ENABLED=1
ORKESTR_OPENAI_API_KEY=<secret>
ORKESTR_MOBILE_REALTIME_MODEL=<supported realtime model>
ORKESTR_MOBILE_REALTIME_VOICE=<supported voice>
ORKESTR_MOBILE_REALTIME_SAFETY_HMAC_KEY=<secret>
ORKESTR_MOBILE_REALTIME_OWNER_ALLOWLIST=<owner-id[,owner-id...]>
```

The owner allowlist is enforced at capability discovery and call creation. `*` enables every owner and should be used only after the staged rollout is complete.

Optional limits have safe defaults:

```text
ORKESTR_MOBILE_REALTIME_MAX_CALL_SECONDS=1800
ORKESTR_MOBILE_REALTIME_MAX_CALLS_PER_DEVICE=1
ORKESTR_MOBILE_REALTIME_MAX_CALLS_PER_OWNER=2
ORKESTR_MOBILE_REALTIME_MAX_CALLS_GLOBAL=100
ORKESTR_MOBILE_REALTIME_CREATE_LIMIT_PER_MINUTE=6
ORKESTR_MOBILE_REALTIME_TOOL_LIMIT_PER_MINUTE=30
ORKESTR_MOBILE_REALTIME_CALL_RETENTION=2000
ORKESTR_MOBILE_REALTIME_EVENT_RETENTION=2000
ORKESTR_MOBILE_REALTIME_TRANSCRIPT_RETENTION=200
```

Raw audio and SDP offers are not persisted. SDP answers are cleared at terminal call state. Provider IDs, device/session bindings, transcripts, and tool correlation stay server-side.

## APNs and Live Activities

Token registration is available independently from delivery. Delivery stays disabled until all Apple settings exist:

```text
ORKESTR_MOBILE_PUSH_ENABLED=1
ORKESTR_APNS_TEAM_ID=<Apple team ID>
ORKESTR_APNS_KEY_ID=<APNs signing key ID>
ORKESTR_APNS_PRIVATE_KEY_FILE=<protected .p8 path>
```

`ORKESTR_APNS_PRIVATE_KEY` may be used when a secret manager injects the PEM value directly. Do not commit it. Normal pushes use topic `com.orkestr.hush`; Live Activity updates use `com.orkestr.hush.push-type.liveactivity`.

The publisher uses a token-free durable outbox with lease-based claiming, exponential retry, collapse IDs, token rotation, and token removal after APNs `410`. Notification text is private by default. Device revocation ends active calls and removes every token for that device.

## Release acceptance

1. Run the server build, focused mobile security tests, the full CI suite, and `npm run oss:boundary-check`.
2. Confirm `GET /api/mobile/realtime` is disabled for an owner outside the allowlist and enabled for an owner inside it.
3. Establish a physical-device call and verify semantic VAD, barge-in, tool idempotency, SSE replay, network transitions, hangup, expiry, and revocation.
4. Verify APNs in both sandbox and production and test a remote Live Activity update from a suspended app.
5. Keep asynchronous `/api/mobile/voice-turns` enabled as the degraded-mode fallback.
