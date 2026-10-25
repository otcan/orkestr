# Explicit retired desktop history adoption

The ordinary desktop lease validator requires unique generations. Some legacy
stores contain repeated historical generations. They remain unavailable by
default. This opt-in recovery format permits repeats only in one externally
authorized, immutable, entirely retired cohort. It does not normalize or discard
corrupt records, renumber history, revive an old lease, or infer writer quiescence
from expiry.

## Trusted configuration and first adoption

The ordinary `desktopLeaseStore(env)` factory recognizes two operator-controlled
configuration values, which must be supplied together:

- `ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_PATH`: absolute canonical receipt path.
- `ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256`: lowercase SHA-256 of its exact
  file bytes, supplied through trusted process configuration.

It never discovers a sibling receipt or trusts a state marker by itself. The
receipt reader requires a regular file, no path symlinks, one link, ownership by
root or the process's effective user, no group/world write permission, and at
most 1 MiB. It opens with `O_NOFOLLOW | O_NONBLOCK`, checks descriptor/path
identity and size/timestamps across the bounded read, then verifies the configured
hash. The hash is the external trust anchor; file metadata alone is not authority.
Operators should place the receipt in protected configuration storage. This is
not a credential or a signature verification scheme.

The first operation resolves and freezes the receipt before acquiring the local
mutation lock. A failure remains failed for that store instance; there is no
marker-based fallback. A successful instance retains its immutable configuration
until replaced. Changing/removing the external file is not a revocation API.
Trusted local tests/compositions can instead pass `legacyAdoption` to the
`DesktopLeaseStore` constructor; it is validated and copied immutably. Supplying
both mechanisms is an error. No HTTP request or state field selects either mode.

Receipt schema, with every displayed field required and extra fields refused:

```json
{
  "format": "orkestr-desktop-legacy-adoption-v1",
  "sourceSha256": "<original-byte SHA-256>",
  "preparedSha256": "<prepared-byte SHA-256>",
  "cohort": {
    "format": "orkestr-desktop-retired-cohort-v1",
    "sourceSha256": "<same original-byte SHA-256>",
    "generationFloor": 8,
    "retiredIds": ["historical-a", "historical-b"],
    "retiredSha256": "<canonical retired-envelope SHA-256>"
  }
}
```

Prepared state contains an exact copy of `cohort` as `legacyRetiredCohort` and has
`fencingCounter == generationFloor`. While the persistent lock's initialization
marker is absent, the file's exact bytes must match `preparedSha256`. A state
file cannot bypass this check by asserting a matching lock identity. Interrupted
publication after state rename but before the initialization marker fails closed
and requires reviewed operator recovery. Subsequent reads and writes
must match the external cohort, all its IDs, and the digest of every complete
retired record, including unknown fields. All cohort records must stay released
and below the floor. Removal, addition, changed content, marker mutation and
unrelease refuse. IDs are unique throughout the store. All non-cohort generations
are unique and strictly above the floor. The counter cannot fall below the floor
or regress in a mutation; existing generation exhaustion checks remain in force.

The existing persistent lock inode/identity rules are unchanged. Copying an
initialized file into a different lock domain does not authorize rebind. An
ordinary store without the external contract refuses any cohort marker, even
if its generations happen to be unique. These checks do not detect arbitrary
offline rollback of all later non-cohort history and its counter; operators must
continue protecting the state file and retained backups from unauthorized writes.

Retired IDs always refuse action entry independently of timestamps. Heartbeat
and release select only active records, so they cannot modify this history.
Acquisition for the old thread creates a fresh record above the floor. If a caller
passes a retired ID, the new record gets a fresh ID/token and current acquisition
and heartbeat timestamps; the retired record remains unchanged.

## Pure preparation API and canonical encoding

`packages/browsers/src/desktop-lease-legacy.js` exports:

```js
prepareLegacyCohort(state, { sourceSha256, revokedAt }) // -> { state, adoption }
serializePreparedLegacy(state)                       // -> UTF-8 Buffer
```

The caller must first read/pin the original bytes with its reviewed offline
publisher and decode them with `parseLegacyJson` from
`desktop-lease-canonical.js`. That parser rejects duplicate object keys, including
escaped aliases, and rejects a leading UTF-8 BOM before decoding byte input.
The same no-BOM rule applies to the external receipt and prepared state, even
when their exact byte hashes match. A U+FEFF character inside a JSON string is
ordinary retained data. The pure preparer performs no I/O and cannot prove that the
provided source digest or writer-fencing assertion is true.

Preparation refuses an existing `lockIdentity` or cohort marker, validates every
ordinary structural rule except repeated generations, and preserves all records,
IDs, versions, tokens and unknown fields. Unreleased records receive exactly
`releasedAt = revokedAt`, `updatedAt = revokedAt`, and
`releaseReason = "legacy_history_retired"`; already released records are unchanged.
`revokedAt` must be an exact UTC ISO timestamp with milliseconds. Since ordinary
structure requires every version to be at most the old counter, the new floor
is the old counter plus one, strictly above both. Preparation refuses a floor
that would leave no usable next generation. Initial acquisition advances again.

`serializePreparedLegacy` is precisely `JSON.stringify(state, null, 2) + "\n"`
encoded as UTF-8. This serialization pins the initial file bytes; it is **not**
the canonical cohort encoding. The exact pinned Node preparer may be invoked by
another-language offline publisher to avoid duplicating numeric conversion.

The SHA-256 digest binds this canonical value:

```js
{ format: "orkestr-desktop-retired-cohort-v1", sourceSha256, generationFloor,
  records: completeRetiredRecordsSortedByUtf8Id }
```

Canonical byte grammar is independent of JSON serialization and locale:

- Null: ASCII `n`; booleans: ASCII `t` or `f`.
- Number: ASCII `d` followed by exactly 16 lowercase hexadecimal digits encoding
  its IEEE-754 binary64 bits in big-endian byte order. Numbers must be finite,
  not negative zero, and have magnitude at most `2^53 - 1`. JSON number tokens
  use correctly rounded binary64 conversion; original decimal spellings are
  retained in the separately pinned original bytes, not this value encoding.
- String: ASCII `s`, decimal UTF-8 byte length without leading zeros, ASCII `:`,
  then the UTF-8 bytes. Unpaired surrogates are refused; no Unicode normalization.
- Array: ASCII `a`, decimal element count, ASCII `:[`, each encoded element in
  order, then ASCII `]`.
- Object: ASCII `o`, decimal member count, ASCII `:{`, encoded key/value pairs
  sorted lexicographically by the keys' unsigned UTF-8 bytes, then ASCII `}`.

For example, `{"z": false, "a": 1}` encodes as
`o2:{s1:ad3ff0000000000000s1:zf}`. Retired record order in the cohort digest is by
ID, rather than its current position among later history.

All values must be JSON data: no getters, exotic prototypes, symbols, holes or
cycles. Limits are cumulative: 8 MiB input/encoded/prepared bytes, depth 64,
100,000 visited values including encoded object keys, 10,000 retired records,
4,096 UTF-8 bytes per retired ID, and 1 MiB receipt. `retiredIds` is a strictly
increasing UTF-8 order list. A limit failure refuses preparation/adoption.

## Operational boundary and tests

The offline publisher owns exact source-byte custody, no-overwrite staging,
source replacement/interruption refusal, and backup/restore evidence. Before any
adoption, the operator must fence every old writer, including direct imports and
CLI paths; a kernel lock cannot fence code still using the old mkdir protocol.
This leaf does not stop services, drain executors, change live files, register a
reload API, or authorize deployment. It supplies the production factory seam for
a separately reviewed activation.

Run focused disposable regressions with:

```sh
node --test test/desktop-lease-legacy-*.test.js test/desktop-lease-action-gate.test.js
```

Tests include pure preservation/refusal, canonical vectors, strict parsing,
factory configuration and a real owned Node subprocess reopen, old action denial,
immutable history, counter/version limits, copied-lock refusal, receipt symlink/
hardlink/FIFO/mode failures and unchanged existing process-lock checks. They use
synthetic files only and do not qualify a production writer drain or rollout.
