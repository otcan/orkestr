# Scoped text outreach broker

This optional operator-managed tool uses existing authenticated transports. It
does not create a WhatsApp account, expose a public endpoint, start a browser,
change thread/group bindings, or add a router account. Install it through the
release train. Keep every actual binding, recipient, credential and service
definition in a private overlay, outside this repository.

## Contract and tools

`scripts/whatsapp-outreach.mjs serve CONFIG` exposes a Unix socket. One broker and
one SQLite journal must admit **both** source accounts for a campaign. A separate
bearer per source grants only the configured thread/account/recipient list. The
caller cannot select a backend or obtain its coordinator credential.

`scripts/whatsapp-outreach-mcp.mjs` is a thread-local stdio MCP adapter. Inject
only these four values through the supported per-thread secret/config mechanism:

- `ORKESTR_OUTREACH_SOCKET`: the protected broker socket.
- `ORKESTR_OUTREACH_TOKEN`: a dedicated scoped bearer, never a transport token.
- `ORKESTR_OUTREACH_THREAD_ID`: the configured thread identifier.
- `ORKESTR_OUTREACH_ACCOUNT_ID`: one configured source account alias.

Tools are `outreach_status`, `outreach_send_text`, `outreach_receipt`, and
`outreach_stop`. Send takes `conversation_id`, `text`, and `idempotency_key`.
The server binds the bearer to an account independently of the client environment.
No history, media, pairing, arbitrary commands, resolution or resume tools exist.

The existing scoped-bridge delegate API is a transport feature, not this
campaign's admission boundary: its default grant also permits history/list reads
and does not enforce a shared cross-account recipient claim, business-hours
window or terminal provider-approval stop. Do not expose its bearer as a
substitute for this send-only grant or activate parallel admissions.

Policy configuration contains `campaignId`, `threadId`, `accounts`, `recipients`,
`timeZone`, `startHour`, `endHour`, `maxNewPer24h` (1–20), and `minSpacingMs`
(at least 60000). Times use an IANA zone; the end hour is exclusive. Duplicate
recipients, group IDs and changed contracts on an existing journal fail closed.

Every recipient is claimed once across both sources. Each source's rolling quota
includes accepted, uncertain and blocked attempts, including imported history
outside the campaign recipient pool. Counting uses the later of attempt/settlement
time. Spacing applies across **both** accounts after completion, conservatively
including slow/failed sends. A reservation commits before the external call.

`state: sent` and provider IDs mean **accepted**, not delivered/read. Accepted
duplicate requests return the original receipt without sending. Interrupted,
timed-out, partial or unjournalable results become uncertain, block further
campaign sends on both accounts, and retain the recipient and quota. There is no
automatic retry, alternative-account fallback, durable work queue or catch-up.

## Private installation contract

The private config contains `policy`, `journalPath`, `socketPath`, `controlPath`,
`grants: [{accountId, tokenSha256}]`, and `backends` keyed by account alias.
Use random scoped bearers (32–256 non-whitespace characters); store only their
SHA-256 hashes in `grants`. Do not commit real configs or bearer values here.

Backend `kind: coordinator-cli` takes an absolute protected `command` implementing
`health` and `send CHAT - --request-id ID` with JSON stdout and text on stdin.
It executes with a clean PATH-only environment and no shell. Backend
`kind: native-worker` takes `socketPath`, fixed `accountId` and optional protected
`tokenFile`, and uses the existing worker's scoped text-only API. Its worker must
independently verify live account identity and thread/recipient permissions. An
unauthenticated health response alone is insufficient for acceptance.

Config/control/baseline files, journal paths/sidecars and backend commands must
be root-owned, non-writable by group/others, and have no symlink or unprotected
ancestor. Use a root-owned 0700 state directory. Use a separate root-owned 0750
runtime directory with a dedicated authorized client group. Run the broker as
root with that group; it creates a 0660 socket and requires account-specific
bearers as well. Actual systemd hardening, credential mounts and allowed
read/write paths belong to the private overlay; do not add broad sudo access.
No existing WhatsApp bridge or router restart is required by this broker.

The protected control JSON is re-read before each attempt and after health:

```json
{"enabled":false,"officialCloudApiApproved":false,"baselineImported":false,"legacySendsFenced":false}
```

Enable only after these integration conditions are verified:

1. Fence legacy admissions for **both** campaign sources. Existing unrelated
   routing/replies stay intact; do not revoke their access or revive old campaigns.
2. Reconcile existing provider receipts and uncertainty records. Export an
   account-aware baseline of all prior contacted recipients and recent first
   contacts, not just the new list. Unknown account attribution or provider
   outcome is a blocker, never a reason to assume no sends happened.
3. Offline, run `import-baseline CONFIG BASELINE`. Rows contain `requestId`,
   `accountId`, `to`, `state`, `at` (epoch ms), and `providerId` for accepted rows.
   Imports are atomic/idempotent; conflicts fail. They never grant send access.
4. Update the private picker/logger together: distinguish source accounts, check
   logged rolling first-contact quota immediately before each send, exclude all
   prior contacts/opt-outs/touches and journal claims, and log only real acceptance
   IDs with the correct source account. All automated new-recipient admissions
   covered by the quota must share this journal; a baseline alone cannot observe
   later sends made outside the broker. Keep approved timers/windows unchanged.
5. Register separate scoped MCP instances for both sources in only the approved
   thread. Verify each status/denial using no live sends. Only then attest
   `baselineImported`/`legacySendsFenced` and enable in protected control state.

`outreach_stop` is a durable, one-way stop for the entire campaign with reason
`owner_stop` or `official_cloud_api_approved`. The official approval workflow must
set `officialCloudApiApproved:true` and invoke stop before any further campaign
attempt. Observing the approval flag on send or status also latches the permanent
stop in the journal; flipping the flag back cannot resume the campaign.
Unknown approval status must disable sending; there is no built-in
provider approval polling or second timer.

## Recovery and rollback

A kernel-enforced Unix listener at `journalPath + '.lease'` is acquired before
opening/recovering SQLite. Another broker or offline importer cannot recover a
live send. A stale lease fails closed: the operator must verify no owning process
and preserve the journal before removing a stale socket. Never unlink on start.

After verifying provider history, stop the broker gracefully and run
`reconcile CONFIG EVIDENCE_JSON` offline. Evidence contains `requestId`, `outcome`
(`sent` or `blocked`), `evidenceRef`, and `providerId` only for confirmed acceptance.
This records a durable resolution. A confirmed non-send remains blocked and its
recipient is never released for a resend. No scoped client can reconcile records.
Stop during an in-flight send preserves its actual result; it cannot unsend it.

Rollback: set protected `enabled:false`, gracefully stop only this broker (allow
at least 150 seconds for an in-flight transport), and remove the two scoped MCP
registrations. Preserve the journal, receipts, baseline and existing sessions.
Do not resume a legacy campaign path until its records are reconciled with this
journal; do not replay queued/uncertain work or change unrelated router bindings.

## Verification

Run `node --test test/whatsapp-outreach.test.js` for synthetic admission, quota,
window, cross-account overlap, slow-send spacing, restart, stop, lease, transport
and stdio MCP tests. No test uses production credentials or sends WhatsApp.
`readyToAttempt` reports local policy gates, not live connection eligibility.
