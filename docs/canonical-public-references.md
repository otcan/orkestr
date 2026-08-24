# Canonical public references

Orkestr can assign immutable, opaque public references to the local runtime,
registered broker instances, and threads. Instance references use `ins_` and thread references use
`thr_`; both contain 128 bits of random entropy encoded as canonical base64url.
Internal instance IDs, thread IDs, names, and bindings remain unchanged.

This foundation is disabled by default. It does not enable canonical HTTP
routes by itself. To preview the backfill:

```bash
npm run canonical-refs:migrate -- --dry-run
```

The dry run reports counts only. It deliberately does not generate references
that could be mistaken for committed assignments. To apply:

```bash
ORKESTR_CANONICAL_INSTANCE_URLS=1 npm run canonical-refs:migrate -- --apply
```

Apply validates every existing reference and collision before writing. It is
idempotent: subsequent applies retain the same references. If the instance
identity write fails, the thread write is restored to its pre-migration state.
The supported JSON registry writer uses atomic temporary-file replacement, and
the SQLite writer commits each registry replacement in one transaction. The
migration restores earlier stores when a later atomic write reports failure;
operators should not substitute writers that persist successfully and then
throw without providing their own transaction or recovery boundary.

Roll back routing by disabling `ORKESTR_CANONICAL_INSTANCE_URLS`. Do not delete
assigned references: they are additive aliases and remain available for a later
roll-forward. Legacy IDs and names continue to be persisted for compatibility.

## Broker registration idempotency

Canonical broker registration creates a private 256-bit registration intent in
`ORKESTR_HOME/secrets/broker-registration-intent.json` before making the first
network request. The file is written atomically with owner-only permissions and
binds the intent to the tenant client-key fingerprint, normalized broker origin,
registration authorization scope, relay account, and WhatsApp target. Version,
display name, capabilities, endpoint URLs, request metadata, and timestamps are
operational fields and are deliberately excluded from the immutable intent
scope.

The broker stores only hashes of the intent and its binding. An exact replay
from the same client key and authorization/target scope updates the existing
instance record, preserves its instance ID and public reference, rotates its
encrypted channel, and returns a fresh decryptable welcome. Open registration
accepts this exact replay without granting callers permission to select an
arbitrary instance ID. Key, authorization, relay-account, or WhatsApp-target
changes fail closed. Raw registration intents must never be placed in broker
records, list responses, events, metrics, or logs.

When a broker record predates canonical references, the tenant may adopt that
exact record once. Adoption does not trust knowledge of the legacy UUID or a
copied public key. The tenant encrypts an intent-, instance-, and target-bound
adoption proof with its existing broker channel key; the broker decrypts it
against the legacy record and also requires the existing client-key fingerprint,
authorization scope, relay account, and WhatsApp target to match. It then adds
the intent hashes and public reference to the same record. If the adoption
response or local cache write is lost, an exact intent replay may include the
same proof and still returns that record with a fresh channel. Missing, invalid,
cross-intent, key-mismatched, authorization-mismatched, or target-mismatched
proofs fail closed. Open registration still cannot select arbitrary instance
IDs.

Broker base URLs are canonicalized before cache, intent, and request use, so
hostname case, default ports, and trailing path slashes do not fork an intent.
Only absolute HTTP(S) URLs without credentials, query strings, or fragments are
accepted.

After the instance identity and broker registration cache are durable, the
tenant removes only the exact matching pending intent. If cleanup is interrupted,
the next cache reuse reconciles the matching cache and removes the leftover
intent before accepting a new scope. Broker-side intent hashes remain with the
instance for its lifetime so delayed retries cannot create a duplicate; normal
instance deletion removes them with the record.

A canonical local identity with neither a durable registration cache nor a
pending intent is not enough evidence to recreate or claim broker state. The
client reports `broker_registration_recovery_intent_missing` before making a
network request in both open and token modes. Importing an existing standalone
identity into a broker therefore requires a separate explicit reconciliation
workflow; registration must not guess.
