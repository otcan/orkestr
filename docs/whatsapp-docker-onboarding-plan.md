# WhatsApp in Docker onboarding: two modes, one transport (plan)

Status: **proposal**, 2026-10-11. Section 1 describes what exists on `main`
(4b520936) and cites code. Everything after section 2 is proposed unless it is
marked *implemented on this branch*. Tests are synthetic; nothing here needs a
real WhatsApp account, real sending, or live credentials.

Goal: a person runs the Docker image, connects Codex or Claude Code, picks a
WhatsApp mode, binds exactly one authorized chat, gets a default thread with a
Virtual Desk, sees a reply to an inbound message, and keeps working after a
container restart.

- **Mode A, self-hosted.** WhatsApp Web paired by QR to a bridge inside the
  user's own container. Credentials live only in the user's `/data` volume.
  No dependency on infrastructure run by Orkestr.
- **Mode B, managed gateway (optional, invitation-only).** The instance uses
  the operator's existing WhatsApp connection through a gateway. It gets a
  scoped, revocable per-instance credential and a per-conversation allowlist,
  and is never exposed to another tenant.

Both modes implement one transport interface, so threads, routing, outbox,
dedupe and replay safety are shared.

## 1. What exists today (verified by reading `main`)

### Local bridge (base for mode A)

- **Engine:** `whatsapp-web.js` 1.34.7 over puppeteer/Chromium
  (`package.json`). It is loaded lazily in
  `packages/connectors/src/whatsapp-local-bridge.js` and uses `LocalAuth`.
  Session data goes to `<ORKESTR_HOME>/whatsapp-bridge/sessions/session-<clientId>`.
- **Where it runs:** in the API server process by default. A separate worker
  (`scripts/orkestr-wa-worker.mjs`, Unix socket) and a loopback HTTP service
  (`scripts/orkestr-wa-service.mjs`) also exist.
- **QR:** the `qr` event writes `whatsapp-bridge/qrs/<account>.{svg,png,txt}`.
  The QR is served at `GET /api/connectors/whatsapp/accounts/:id/qr.svg`, which
  checks permissions, and at `GET /api/connectors/whatsapp/bridge/qr.svg`. Phone
  pairing codes are supported. The QR panel is in
  `apps/web/src/app/onboarding-page.component.html` (`qr-panel`).
- **States:** `idle`, `starting`, `qr_needed`, `pairing_code`,
  `authenticated`, `ready`, `auth_failure`, `disconnected`, `startup_timeout`,
  `auth_ready_timeout`, `failed`, `degraded`, `dependency_missing`,
  `stale_runtime`.
- **Inbound path:** echo suppression, then dedupe on event or source message
  id (`whatsapp.js` `inboundEvents`), then the binding match
  (`whatsapp-inbound-routing.js`), then the sender policy
  (`whatsapp-inbound-security.js`).
- **Outbound path:** connector outbox, then a delivery-ledger claim
  (`whatsapp-delivery-ledger.js`), then a confirmed send
  (`whatsapp-send-confirmation.js`). A send that may have happened is never
  resent; it goes to `delivery_uncertain` (`whatsapp-replay-safety.js`).
- **Tests:** about 50 `test/whatsapp*.test.js` files. All use fake
  `Client`/`LocalAuth` and runtime hooks.

### Hosted relay and broker (closest thing to mode B)

- **Registration:** an instance registers with the broker
  (`packages/core/src/broker-instance-registry.js`,
  `apps/server/src/modules/broker/broker.controller.ts`) using one shared
  registration token, or none when `ORKESTR_BROKER_REGISTRATION_OPEN=1`.
- **Channel:** each instance gets a channel encrypted with X25519, HKDF and
  AES-256-GCM, and is limited to one self-declared `whatsappChatHash` and
  `relayAccountId`.
- **Admin-provisioned tenant VMs:** these get per-chat scoped tokens
  (`tenant-whatsapp-routing.js`, `whatsapp-scoped-tokens.js`).
- **Bindings:** precedence is chat > thread > instance > user > account. A
  tie at the same level counts as ambiguous and is rejected. Bindings carry
  send, read, receive and manage modes (`whatsapp-binding-registry.js`,
  `whatsapp-binding-acl.js`).

### Docker first run

- **Image:** installs Chromium and production dependencies, so
  `whatsapp-web.js` is in it. The entrypoint defaults
  `ORKESTR_WHATSAPP_ACCESS_MODE=relay`. State is under `/data`.
- **First-thread wizard:** welcome, coding agent (Codex or Claude Code),
  WhatsApp ("Orkestr relay" or "own bridge"), review. It then creates the
  `orkest` thread, wakes it if the provider is ready, and leases and starts
  the Virtual Desk (`first-thread-wizard.component.ts`).
- **Pairing approval:** browser pairing is approved from the host shell
  (`orkestr connect approve <code>`).

## 2. Gaps found (each is a work item below)

| # | Gap | Evidence | Mode |
|---|---|---|---|
| G1 | The stock image very likely cannot launch Chrome for the local bridge. Nothing sets `WA_CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH`, and npm runs with `--ignore-scripts`, so puppeteer never downloads its Chrome. With an empty cache, puppeteer resolves to a missing binary. This was simulated locally, not run in a container. | `Dockerfile`, `docker-entrypoint.sh`, `whatsapp-local-bridge.js` (`WA_CHROME_PATH`) | A |
| G2 | The wizard's WhatsApp choice is written to `runtime-settings.json` (`accessMode`, `bridgeMode`) but does not change transport behaviour. That is decided by `WHATSAPP_BRIDGE_MODE` and the connector config. | `system.controller.ts` `setup/demo-preferences`; `whatsapp.js` `bridgeMode()` | A/B |
| G3 | The default is `relay`, which depends on infrastructure run by Orkestr. Mode A must work with no broker URL at all. | `docker-entrypoint.sh` | A |
| G4 | The bridge does not auto-start after a container restart unless `ORKESTR_WHATSAPP_AUTOSTART=1`. | `whatsapp-local-bridge.js` `startConfiguredLocalWhatsAppAccounts` | A |
| G5 | `setupState` is `ready` only with OpenAI, Codex, WhatsApp, mail and LinkedIn all connected, so a WhatsApp-plus-Codex install never shows ready. | `packages/core/src/setup.js` | A/B |
| G6 | The inbound sender policy is fail-open by default (`legacy-open` when a binding has no owner or account). | `whatsapp-inbound-security.js` | A/B |
| G7 | Broker registration uses one shared token and has no single-use invitations. | `broker-instance-registry.js` | B |
| G8 | A heartbeat sets `status="online"`, which undoes a status-only revocation; only `disabledAt` holds. Relay calls don't check `expiresAt`. | `broker-instance-registry.js` heartbeat | B |
| G9 | An instance declares its own relay account and target chat hash, and can change the account by heartbeat. | `broker-instance-registry.js` | B |
| G10 | Relay envelopes have no nonce or timestamp, so they can be replayed. | `broker-instance-registry.js` envelope | B |
| G11 | Scoped tokens are stored in plaintext and have no revoke or rotate API. Disabling a tenant route leaves its tokens valid. | `whatsapp-scoped-tokens.js`, `tenant-whatsapp-routing.js` | B |
| G12 | Nothing makes chat ownership unique; one chat could route to several tenants. | `tenant-whatsapp-routing.js` | B |
| G13 | Readiness probes don't reflect WhatsApp state, and nothing tells the user to wait while the bridge is still connecting. | `server.ts` startup order, `/api/health` | A/B |
| G14 | `scripts/smoke-k3s-oss-demo.mjs` expects the old image repository name and fails as committed. | script line ~85 vs `charts/orkestr/values.yaml` | ops |
| G15 | `POST setup/demo-preferences` has no admin check, unlike nearby handlers. Unverified whether that matters. | `system.controller.ts` | A/B |

## 3. Target architecture

### 3.1 One transport interface

Proposed location: `packages/connectors/src/whatsapp-transport/`. The style
follows [spec/adapter-interface.md](spec/adapter-interface.md): fixed lifecycle plus
explicit capabilities.

```js
export const transport = {
  id: "local-bridge" | "gateway",
  capabilities: { qrPairing: boolean, phonePairing: boolean, groups: boolean,
                  media: boolean, history: boolean },
  async status() {},                  // -> { state, accountId, reason?, since }
  async start({ signal }) {},         // idempotent; never pairs a new account by itself
  async stop({ reason }) {},          // idempotent
  async pairing() {},                 // -> { kind: "qr" | "code" | "token", ... } (mode-specific)
  onInbound(handler) {},              // handler(InboundEvent) -> Promise<void>; ack after durable write
  async send({ chatId, text, idempotencyKey }) {},  // -> { state: "sent" | "stored" | "uncertain" | "rejected", messageId? }
};
```

- **`InboundEvent`:** `{ transportId, accountId, chatId, senderId, messageId,
  timestamp, text, media?, transportSeq }`. Dedupe uses
  `(transportId, accountId, messageId)` and reuses the existing
  `inboundEvents` and replay logic.
- **`send` is at-most-once per `idempotencyKey`:** a repeated key returns the
  first result. `uncertain` maps onto the existing `delivery_uncertain`, so
  nothing is ever resent automatically.
- **Mode A adapter:** wraps the existing local-bridge functions and changes no
  behaviour. **Mode B adapter:** the gateway client from 3.3.
- **The mode is set in one place:** `connectors.whatsapp.mode` =
  `"self-hosted" | "gateway" | "off"`, read through a single resolver.
  Existing `WHATSAPP_BRIDGE_MODE` values keep working and take precedence, so
  current deployments don't change. The wizard writes this field (fixes G2).

### 3.2 Mode A: self-hosted (no Orkestr-hosted infrastructure)

- **Image:** the entrypoint exports `PUPPETEER_EXECUTABLE_PATH` as the bundled
  Chromium when it isn't set and the binary exists (fixes G1).
  `doctor whatsapp` reports which Chrome was found.
- **Mode selected:** no broker URL, registration or heartbeat; the wizard
  turns them off. The transport layer refuses to start a gateway client when
  the mode is `self-hosted`. A test asserts that no request goes to a
  non-loopback host during onboarding with a fake bridge.
- **Session:** stays in `/data/whatsapp-bridge/sessions` (directories 0700).
  Once an account has paired successfully, a `paired` marker in the volume
  makes the bridge auto-start on boot without `ORKESTR_WHATSAPP_AUTOSTART`
  (fixes G4). Logout clears the marker and the session.
- **Binding:** onboarding binds exactly one chat that the user picks from
  recent chats or a self-chat. The binding sets `ownerParticipantIds` to the
  paired account, so security starts as `owner-only` (fixes G6 for new
  bindings; old bindings are unchanged).

### 3.3 Mode B: managed gateway (invitation-only)

The gateway protocol and client live in OSS. The gateway deployment, the
operator's WhatsApp account and the invitation issuing are private operator
concerns.

1. **Invitation.** The operator issues a single-use invite code: random,
   expires in 24h or less, stored as a SHA-256 hash. It is tied to one
   intended chat (or "chat chosen on first message from the owner"), a quota,
   and an expiry for the resulting instance.
2. **Enrollment.** The instance makes a key pair and sends
   `POST /gateway/enroll { inviteCode, instancePublicKey }` over outbound
   HTTPS. The gateway burns the code and creates `instanceId` plus a
   credential: a key-bound channel (reusing the existing
   X25519/HKDF/AES-GCM code) and a short-lived access token (≤ 1h, refreshed
   with a key-bound refresh). The gateway stores only hashes. The instance
   keeps them in `/data/secrets` (0600).
3. **Scope is set by the gateway.** The relay account and the allowed chat
   list come from the invitation record. The instance cannot set or change
   them (fixes G9). Each chat is owned by at most one instance, enforced by a
   unique index (fixes G12).
4. **Every call is checked.** Each request carries `{ instanceId, nonce, ts,
   seq }` inside the AEAD. The gateway rejects revoked, disabled or expired
   instances, `ts` outside ±120s, and any nonce already seen within the
   window (fixes G8 and G10). Heartbeats never change revocation state.
5. **Inbound.** The gateway routes a message only to the instance that owns
   the chat. The instance pulls by long-poll or WebSocket, so the Docker host
   needs no open inbound port. The instance acks after its durable write; the
   gateway redelivers unacked events. Delivery is at-least-once and the
   instance dedupes on `messageId`.
6. **Outbound.** Only to the allowlisted chat, with `idempotencyKey`, and a
   per-instance rate limit and daily quota.
7. **Revocation and rotation.** Operator APIs to revoke an instance (takes
   effect on the next call), rotate keys, and list instances, plus an audit
   event for each. Tokens are stored hashed (fixes G11 for the gateway path).

### 3.4 Onboarding flow and states

1. **Pair this browser** (exists).
2. **Connect a provider.** Codex device auth (exists) or a Claude Code
   account (exists, but needs `ORKESTR_CLAUDE_CODE_ENABLED` and the `claude`
   CLI, which the image doesn't include; a separate decision).
3. **Choose WhatsApp:** "On this server (scan a QR)" or "Managed gateway
   (invitation code)". The default is mode A.
4. **Connect.** Mode A shows the QR with live state from `status()`. Mode B
   takes the invitation code and shows the enrollment result.
5. **Bind one authorized chat.** Create the binding, owner-only.
6. **Create and start** the default thread and Virtual Desk (exists).
7. **Prove it works.** "Send `hi` from that chat." The UI waits for the
   inbound event and the thread's reply, and shows ✔ inbound and ✔ reply.
8. **Restart check** (optional button). After a restart the status returns to
   `ready` with no QR (mode A) or no new enrollment (mode B).

Add a goal-specific readiness value, `setup.goals["whatsapp-agent"]`, that
needs only the provider, WhatsApp `ready` and one bound chat. `setupState`
itself is unchanged, so its existing callers keep their meaning (fixes G5).

## 4. Acceptance matrix

Test types: **U** unit, **F** synthetic integration with a fake transport and
temporary `ORKESTR_HOME`, **B** headless browser with a fake bridge, **R**
real account (manual, only with explicit authorization; not part of CI).

| ID | Criterion | Mode | Test |
|---|---|---|---|
| T1 | The transport contract (status, start, stop idempotence, pairing, inbound ack, send idempotency) holds for the fake transport and both adapters. | A/B | U |
| T2 | One resolver decides the mode; legacy `WHATSAPP_BRIDGE_MODE` wins; the wizard choice changes the effective mode. | A/B | U |
| T3 | The image entrypoint gives the bridge a Chrome path that exists; `doctor whatsapp` reports it. | A | U + container smoke |
| T4 | QR flow: `qr_needed` → QR served → `ready` with a fake client; QR files removed after `ready`. | A | F, B |
| T5 | No request to non-loopback hosts during mode A onboarding (network spy). | A | F |
| T6 | Session is under `/data`, directories 0700; after a simulated restart the bridge auto-starts from the paired marker with no QR. | A | F |
| T7 | Binding one chat makes it owner-only; another sender is denied; an unbound chat is not routed. | A/B | U/F |
| T8 | An inbound message gets exactly one reply even when the event is delivered twice or replayed after a restart. | A/B | F |
| T9 | A crash between send and ledger write gives `delivery_uncertain`, never a second send. | A/B | F (exists, extend) |
| T10 | Invite code is single-use, expires, and is stored hashed; reuse is rejected. | B | U |
| T11 | Revoke stops the next call; a heartbeat can't revive a revoked instance; expiry is enforced on every call. | B | U/F |
| T12 | Replay (same nonce, or `ts` outside the window) is rejected. | B | U |
| T13 | An instance can't change its relay account or allowed chats; sending to a chat not on its allowlist is rejected. | B | U/F |
| T14 | A chat can't be owned by two instances; inbound for chat X reaches only X's owner (two-tenant fake). | B | F |
| T15 | Gateway down or disconnected: the instance shows `disconnected`, queues outbound, and resumes with no duplicates. | B | F |
| T16 | The wizard covers provider → mode → connect → bind → thread and desk → inbound/reply proof, all with fakes. | A/B | B |
| T17 | Goal readiness is true with a provider, WhatsApp `ready` and one binding; legacy `setupState` is unchanged. | A/B | U |
| T18 | Image upgrade with an existing volume: the session and bindings are still used and no re-pair is needed (fixture volume). | A | F + container smoke |
| T19 | Real pairing, inbound and reply on a test account, including restart persistence. | A | R (authorized only) |
| T20 | Real gateway enrollment and revoke on a staging gateway with a test number. | B | R (authorized only) |

## 5. Risks and mitigations

- **Unofficial WhatsApp Web automation.** This is not the WhatsApp Business
  API. Accounts can be limited or banned, and WhatsApp Web changes can break
  the bridge.
  - Mode A stays explicitly user-owned and opt-in, with clear wording.
  - The `whatsapp-web.js` version and patch stay pinned; startup surfaces a
    `degraded` state instead of failing silently.
  - Business API support could become a third transport later, using the same
    interface.
- **Account controls.** Mode B uses the operator's account for several
  instances.
  - Per-instance rate limits and daily quotas, outbound only to allowlisted
    chats, no group creation, and revocation from the operator console.
  - Invitations only for people the operator knows.
- **Disconnections and logouts.** Map them to `status()`, notify once per
  incident (the existing repair notices), queue outbound, and never resend
  uncertain sends.
- **Duplicate messages.**
  - Inbound dedupe on `(transport, account, messageId)`, persisted.
  - Outbound idempotency key plus the delivery ledger.
  - The gateway acks only after the instance's durable write.
- **Startup race.** The server is ready before the bridge.
  - The UI shows "WhatsApp connecting".
  - Inbound handlers are registered before `start()`.
  - Outbound waits on `status()` with backoff; a readiness check for
    WhatsApp is added for operators.
- **Replay** of gateway requests: nonce, timestamp and sequence inside the
  AEAD (T12).
- **Security and cross-tenant exposure.**
  - Fail-closed defaults for new bindings.
  - Chat ownership is unique.
  - Scopes are set by the gateway.
  - Tokens are stored hashed, short-lived and revocable.
  - Nothing from mode B is enabled in mode A.
- **Docker updates.**
  - Pin and test Chromium and `whatsapp-web.js` together.
  - The session format may break on library upgrades: detect it, keep a
    backup, and ask for a re-pair rather than looping.
  - The volume layout is versioned with a migration check.
- **Secrets in volumes.** `/data` holds the WhatsApp session, provider logins
  and the gateway credential. Document backup and restore, and permissions of
  0700/0600.

## 6. Implementation increments

Each increment is a small PR, behaviour-neutral for existing deployments
unless stated otherwise.

1. **Plan and transport contract.** This document; the `whatsapp-transport`
   interface, a fake transport and contract tests (T1). No wiring. *Done on
   this branch.*
2. **Gateway credential primitives** as a standalone module: invite codes,
   hashed tokens, revoke and expiry, nonce/timestamp replay window, chat
   ownership index (T10–T14, units only). No routes. *Done on this branch.*
3. **Chrome path in the entrypoint** plus a doctor check (T3).
4. **Mode resolver** plus the wizard writing `connectors.whatsapp.mode`
   (T2). Legacy env keeps precedence.
5. **Local-bridge adapter** behind the interface; paired-marker auto-start
   (T4, T6).
6. **Onboarding "bind one chat" and "prove it" steps;** goal readiness
   (T7, T16, T17).
7. **Gateway client adapter plus gateway routes** using module 2 (T11–T15).
   The gateway deployment and invitation issuing stay private.
8. **Container smokes** for T3/T18 and the k3s smoke fix (G14).

## 7. Test policy

All CI tests use fakes and a temporary `ORKESTR_HOME`. Real-account tests (T19,
T20) need explicit owner authorization per run, a dedicated test number, and an
isolated home, and are never wired into CI or release gates. Do not change
existing WhatsApp sessions or issue live gateway tokens as part of this work.
