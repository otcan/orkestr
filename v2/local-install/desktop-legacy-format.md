# Offline legacy retired-cohort preparation

This preparer writes only a fresh private evidence directory. It does not update
an installed store, adopt a lock, signal a writer or establish quiescence. The
operator must separately fence every writer and independently trust the external
adoption receipt. Current validator integration must be reviewed before use.

```
python3 -B v2/local-install/desktop_legacy_prepare.py \
  --source /private/offline/original.json \
  --source-sha256 <exact-lowercase-sha256> \
  --target /private/offline/fresh-evidence \
  --offline-source-confirmed
```

Both parents must already be canonical caller-owned private directories. The
source must be a stable nofollow regular single-link file, at most 8 MiB. The
output directory must not exist. An initialized source or existing cohort marker
is refused. This path is specifically for legacy state without embedded lock
identity; the separate initialized-state recovery protocol remains unchanged.

Every original record and unknown field is retained. Repeated historical
versions are not renumbered. Every unreleased record is released with explicit
`offline-legacy-adoption-revoked` reason. Already released records are unchanged.
The new counter and cohort floor equal `max(old counter, old versions) + 1`;
headroom for a strictly newer next acquisition is required. Other legacy
structural errors remain refusals. No expiry-based inference is used.

The bundle contains exact `original.json`, prepared `leases.json`, external
`adoption.json`, and hash-only transport `bundle.json`, each mode 0600 under a
0700 directory. Files and directories are fsynced; Linux renameat2 NOREPLACE
publishes atomically to a fresh target. Prepublication errors clean only the own
staging directory. Publication uncertainty preserves evidence and refuses retry
or activation. SIGTERM/SIGHUP enter the same cleanup handling; SIGKILL and power
loss can leave a private staging directory requiring separate inspection.

## Shared canonical contract

Proposed contract coordinated with the public validator owner:

- Adoption format `orkestr-desktop-legacy-adoption-v1` has `sourceSha256`,
  `preparedSha256` and `cohort`.
- Cohort format `orkestr-desktop-retired-cohort-v1` has `sourceSha256`,
  `generationFloor`, UTF8-byte-sorted `retiredIds`, and `retiredSha256`.
- Prepared state has the identical cohort as `legacyRetiredCohort`.
- `preparedSha256` hashes the exact emitted leases.json bytes, including newline.
- `retiredSha256` hashes canonical encoding of exactly the object
  `{format, sourceSha256, generationFloor, retiredRecords}`. The complete prepared
  records are sorted by their UTF8 ID bytes in `retiredRecords`; unknown fields
  are included. The state's original record order is retained.

Canonical encoding is binary concatenation without whitespace or separators:
null `n`, true `t`, false `f`; number `d` followed by 16 lowercase big-endian
IEEE754 hexadecimal digits; string `s` + decimal UTF8 byte length + `:` + UTF8
bytes; array `a` + decimal length + `:[` + encoded children + `]`; object `o` +
decimal own string-key count + `:{` + encoded key/value pairs sorted by UTF8 key
bytes + `}`. Empty arrays and objects encode `a0:[]` and `o0:{}`.

Input must be UTF8 JSON without BOM. Duplicate keys, unpaired surrogates,
nonfinite numbers, negative zero, magnitude above MAX_SAFE_INTEGER, depth above
64, node count above 100000 or canonical output above 8 MiB refuse. Root depth is
zero; each value and each object key counts as a node. JSON numbers have IEEE754
semantics; safe integral lexical integers are retained exactly. Original lexical
bytes always remain in original.json. The implementation uses Python's
big-endian double packing and UTF8 bytes; a separate Node encoder test checks
cross-language compatibility, including astral/BMP ordering and subnormals.

The validator owner must test actual store adoption, reopen, every old binding's
refusal, strict fresh uniqueness and generation, and receipt/cohort tamper refusal.
The preparer tests alone do not establish these properties. A persisted marker
without the independently trusted constructor receipt must never enable legacy
exceptions. A legacy writer can discard unknown top-level marker fields, so
writer fencing remains mandatory across HTTP and direct connector runtimes.

Current rollout inventory must include direct connector MCP and WhatsApp sender
runtimes that import the desktop store, alongside the UI HTTP writer. The public
HTTP deployment can use a distinct state home; establish targets per process
without dumping environments. External websocket executor identity is separate
from UI transport identity. An empty job table and no current UI stdio child are
observations, not a substitute for a controlled writer fence. Root owns concrete
rollout and session-preservation evidence; this tool performs no process actions.
