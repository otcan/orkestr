# Top resource bar provider quotas (ORK-717)

The authenticated Rust UI independently reads `/api/v2/provider-quotas` every
30 seconds, after its previous request completes. It integrates OpenAI / Codex and
Claude into the CPU/RAM/disk resource navbar. Only reported quota windows appear;
absent short-window limits are omitted. The compact summary shows numeric remaining
percentages or explicit provider-reported availability (available / near limit /
limited). Expand a provider with mouse or keyboard for reset times and observation
freshness. A connected account does not imply a quota observation. Expired or missing
telemetry is labeled explicitly rather than displaying question marks or free quota. A transport
failure clears the previous display to unavailable. Quota polling does not block
the CPU/RAM/disk summary or spend provider allowance.

The server endpoint is browser-owner-only and projects a closed set of safe
fields from the maintained passive V1 `/api/quota/providers` API. It strips raw
telemetry, account/source identifiers and any unexpected fields. The browser
cannot supply an owner selector. Session authority is rechecked after the remote
read; unmapped owners receive unavailable, never the default operator account.

## Trusted startup enrollment

Set `ORKESTR_V2_PROVIDER_QUOTA_CONFIG` to a private regular JSON file (0600,
owned by the service UID). Example with synthetic identities only:

```json
{
  "v1_url": "http://127.0.0.1:19880",
  "bearer_token": "REPLACE_WITH_MAINTAINED_OPERATOR_CREDENTIAL",
  "owner_id": "11111111-1111-4111-8111-111111111111",
  "legacy_owner_id": "synthetic-legacy-owner"
}
```

The existing loopback broker transport validates URL and credential shape and
bounds reads to five seconds / 16 KiB. The explicit owner pair must be enrolled
from verified existing Core/V1 ownership by the release operator; neither UI nor
model guesses the mapping. This source change does not enroll credentials,
modify permissions or initiate provider refresh/canary requests. Without config
the bar honestly shows unavailable. The original passive producer and V1 cache
remain responsible for collecting account-wide numeric telemetry.

Validation: JS model/request tests cover both providers, zero quota, resets,
stale/limited states, expired/future/invalid/unknown observations, fixed cookie
transport and oversized/malformed replies. Rust tests cover safe-field stripping,
invalid numeric/text/status rejection, preservation of status-only Claude windows and
bounded producer staleAfterMs policy (up to seven days), browser versus machine authority, explicit owner
mapping, requested-owner refusal and revocation during remote reads. The browser
scenario checks actual WASM navbar items, omitted absent short windows, status-only Claude, and
keyboard-accessible expanded reset details at desktop
and phone widths. Rust/browser CI execution is required before release.
