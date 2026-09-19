# WhatsApp group creation adapter

Some Web builds lazy-load the New Group bundle. A create may load the owned
page's `WAWebNewGroupFlowLoadable.requireBundle` once, with a ten-second bound,
before resolving the create function again. The read-only protocol probe does
not load it. Failure to load or resolve the function is pre-dispatch failure;
there is no SDK fallback or external retry.

Post-create setup tolerates delayed group metadata without falling through to
an SDK lookup that can reset the sender. Admin promotion excludes existing
admins/the creator and is a no-op once applied. Receiving-account checks use
trusted live account mappings as well as the legacy persisted account cache;
they do not accept aliases from the inbound payload or grant receiving rights
from the reply account. Explicit non-sender rejection is not successful inbox
delivery and requires an operator replay after correction.

The worker uses a purpose-specific browser adapter instead of the SDK's
`createGroup` orchestration. It runs exclusively through the owning connector
client's page; it does not discover a browser by port or navigate a desktop.

The SDK's generic `CreateGroupError` discards the actual failure, and its
post-create participant/invitation processing can throw before returning the
group ID. The adapter returns the group identity before optional setup, allowing
the existing durable provisioning ledger to save it before admin/picture work.

Compatibility rules:

- Exclude the creator's phone and LID aliases; WhatsApp adds the creator itself.
- Resolve each explicit participant and deduplicate the resolved WIDs before
  dispatch. An unresolved participant rejects the operation before creation.
- Do not force LID addressing for phone-number-only participant descriptors.
  Let the Web client choose its supported addressing mode.
- Use the current Web flag convention for a conversational group (`announce:
  true`). The upstream SDK's `announce: false` convention is inverted on recent
  Web builds, as documented in upstream issue 201767.
- Read `_serialized`, `$1`, or a complete user/server pair for the returned ID.
- Never send invitations, replay a create, or switch to another implementation
  after an attempted dispatch. Optional setup is separate.

The compatible participant resolution and creator exclusion follow the same
contract used by the maintained WPPConnect group implementation; no additional
runtime dependency is introduced:

- https://github.com/wppconnect-team/wa-js/blob/main/src/group/functions/create.ts
- https://github.com/wppconnect-team/wa-js/blob/main/src/whatsapp/functions/sendCreateGroup.ts
- https://github.com/wwebjs/whatsapp-web.js/issues/201767

These compatibility changes are not evidence that a particular historical
failure was caused by one of them. Live verification must establish that.

Forced read-only worker health diagnostics include `groupCreateProtocol`: Web
version, adapter name, API availability and function arity. This probe does not
query participants, create groups, restart services, or expose page source.
Availability proves only API shape, not permission or successful creation.

Failures retain an allowlisted diagnostic name, generic reason, numeric status,
Web version and fingerprint. No raw exception message, stack, participant ID,
group title, token, invitation code, or browser endpoint is exposed.
Pre-dispatch failures are `not_created`; any failure after invoking the create
job remains `outcome_unknown`, with automatic retry disabled.

Focused tests: `test/whatsapp-group-create-client.test.js`, plus the provisioning,
transport, worker/service and WhatsApp regression suites. Real creation remains
an explicitly authorized operator action, never a release gate.
