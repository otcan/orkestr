# Preservation evidence to Core authority mapping

Reviewed Migration checkpoint `45d8339678a3ec1287ad844522df3cd9fe2c5c5a`
against Core proposal `1cbdb3c6d`. The two unchanged Python tests passed in a
disposable export, including ten negative mutations. This establishes checker
behavior only, not Store import or automatic-send acceptance.

| Migration evidence | Core writer requirement |
| --- | --- |
| `source_namespace` + `source_input_identity` | Composite immutable source identity. Target owner/conversation comes from current authenticated import scope, never from this pair. Preserve opaque bytes without timestamp or native-ID conversion. |
| Input `source_revision` | Known lowercase SHA256 or explicit unknown. Evidence digest, not authentication or a target control revision. |
| `hold.source_revision` | Independent hold provenance; never replace it with the input revision or require them to match. |
| `historical_effects` | Preserve every distinct classification and full u64 count, including zero. Mixed classifications coexist; no_record is not unsent and sent does not release a hold. |
| `source_route_generation` | Source evidence only. Unknown stays unknown; a known source generation cannot authorize the current target route. |
| `created_at`, `route_cutoff` | Preserve source metadata verbatim. Neither participates in hold eligibility or permission. |
| `hold.reason` | Persist exact operator/uncertain/unknown reason independently of effect history. |
| `state=dormant`, `replay_policy=never_replay` | Immutable imported disposition. Historical evidence cannot become a fresh reservation by changing a key, enabling permission or replacing a route. |
| `automatic_reply_enabled=false` | Import never grants conversation permission. A separate fresh owner decision is necessary and still cannot release imported holds. |
| `skill_only_routing_enabled=false` | Import creates no router membership. This is a preservation assertion, not permission for Core to manage the separate skill-only account. |

Identity uniqueness is scoped to the source namespace, not a global identity
string. Duplicate semantic import must return its original receipt under current
authentication; changed provenance for an existing identity must conflict rather
than overwrite history. Source evidence and target authorization remain separate
records. Store representation must preserve the complete u64 domain without
lossy conversion to signed SQLite integers or floating point.

The checker intentionally preserves exact effect-array order and complete source
rows. Core must retain that original evidence even if a separate indexed effect
projection is used for refusal checks. No guessed conversion of private legacy
receipt tuples is authorized by this mapping.

## Validation boundaries before writer integration

The current fixture has `created_at` and `route_cutoff` strings, but no distinct
authority `observed_at` field and no canonical UTC parser. Do not relabel
creation time as observation time. A future typed import must capture an explicit
per-authority observation timestamp and validate canonical UTC while preserving
original timestamp metadata; absent historical observation remains explicitly
unknown. The fixture does not prove that stronger validation.

The checker bounds one source envelope to 128 inputs. This is a batch limit,
not permission to drop additional legacy records. Writer/export pagination must
retain all identities across batches and enforce completeness separately. Its
Python UUID parser also accepts alternate UUID spellings; the typed boundary
must select canonical UUID serialization while preserving opaque input identity.

No writer, route registration, session copy, socket change or send is enabled.
Migration continues to own the independent checker; Core owns migration0039,
typed contracts, storage and transaction tests. Schema allocation remains
exclusive and does not change immutable migrations0037/0038.
