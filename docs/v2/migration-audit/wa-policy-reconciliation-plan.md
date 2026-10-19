# Read-only WA mute and held-input reconciliation

This is an inspection plan, not a routing change. Keep the main routing mute,
operator-held inputs and personal skill-only account exclusion in force. Do not
interpret an inactive relay or absent field as permission to route.

## Authorities and distinctions

The application source `packages/core/src/reply-delivery-intent.js` defines
`whatsappReplyDeliveryBindingEligible`: connector, chat/account presence,
`enabled`, `routeEligible`, `mirrorToWhatsApp`, `mirrorReplies`, `deprecated`
and `retired` all affect outbound reply eligibility. Its
`whatsappReplyDeliveryBindingRevision` fingerprints those fields. A disabled
mirror is an outbound fence, not evidence that inbound routing is muted.

The separate connector source `whatsapp-scoped-group-relay.js` snapshots
`config.heldInputIds` when constructing `createScopedGroupRelay`. The fixed
`tick` loop excludes held input before calling `routeInput`. These exclusions
are not completion receipts. Missing configuration defaults to an empty list,
so another process's empty list cannot supersede the operator's retained holds.
Calling this factory is prohibited during diagnostics: it opens a writable
journal, creates tables and constructs a route-fence writer.

`whatsapp-scoped-native-worker.js`, `whatsapp-scoped-route-membership.js` and
`whatsapp-delivery-route-fence.js` separately establish current membership,
route/epoch and uncertain-effect fences. Route ownership alone does not prove
that application mute or held-input policy applies to that path. Worker policy
can be cached; a file snapshot alone does not establish live process policy.

## Bounded inspection procedure

1. Reacquire current service PID/source and named selector keys only. Hash the
   deployed policy implementations. Do not dump process environments, read
   sessions/tokens, or assume a prior PID is still current.
2. Read only source-defined nonsecret policy files using no-follow regular-file,
   size, duplicate-key and before/after stability checks. Keep real account,
   chat, thread and held-input identities in the private evidence directory.
   Compare exact sets internally; report only match/mismatch/unknown publicly.
3. Within one read-only transaction per authority, project the exact main
   binding eligibility flags and revision plus current route/epoch. Query
   sending/uncertain counts without payloads. Never instantiate connector
   factories or call list APIs that initialize or migrate storage.
4. Compare the retained seven-hold set to each active inbound path's policy.
   Establish both membership and precedence: exclusion must happen before
   admission, and remain an exclusion after restart/retry. If current in-memory
   policy cannot be attested through an inert status projection, record UNKNOWN;
   do not restart a process, amend its config or treat file contents as proof.
5. Verify the personal German account is outside every router/autostart
   membership using private set comparison only. Its standalone skill remains
   separately authorized. Do not read its session/profile or invoke it.
6. Save timestamps, source hashes, selector evidence and separate inbound mute,
   outbound mirror, hold, route ownership and uncertain-effect conclusions in
   private 0600 receipts under a 0700 directory. Cross-process observations are
   partial cuts. A failed selector or disagreement keeps the restrictive policy.

## Current unresolved decision and owner handoff

The current census found different policy coverage in sender and inactive relay
configuration. It does not establish effective main mute across all active
paths. Connector/Runtime must identify the authoritative mute control and supply
an inert projection of the live policy revision, direction-specific mute and
held-set digest/count. Migration must compare that projection against retained
private policy before any cutover. This plan requests no shared-file edits.

The smallest synthetic acceptance uses a muted main route, a retained held
input, an otherwise eligible new input and an excluded skill-only account.
Neither muted nor held nor excluded input may enter intake or send. An explicit
future owner transition may admit only the eligible new input; restart/replay
must not consume held inputs or reinterpret them as completed. Unknown or
uncertain effect states remain held. No real sends are required.
