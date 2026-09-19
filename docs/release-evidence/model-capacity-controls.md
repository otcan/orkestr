# Model Capacity controls (ORK-503)

The Model Capacity overlay now offers the runtime's live model catalog and each
model's supported reasoning efforts. Opening the overlay mounts the control;
background summary polling does not fetch the catalog. Catalog reads use a
15-second cache scoped to the runtime client and a five-second connection/catalog
deadline. Applying a change refreshes the catalog before validating the pair.
Unavailable current models are explicitly identified instead of silently selected.
Controls wrap on narrow screens and use at least 44-pixel touch targets.

`GET /api/threads/:id/model-settings` and
`POST /api/threads/:id/model-settings` enforce current-owner/admin access. POST
uses the existing thread-action sanitizer and the same settings operation as
`/model`, `/effort <level>` and `/fast`. The existing `/model` command is retained.
`/effort` validates against the current model; invalid commands produce a clear
reply without a task turn or an answer to a pending user-input question. Raw
terminal runtimes and tenant-policy-controlled threads are read-only.

Changes acquire a cross-process lock for the exact thread, reread current state,
validate, record durable pending intent, request the runtime update, and persist
the acknowledged settings in both explicit and executor metadata. The lock wait
and runtime request each have a five-second bound. The UI waits up to 20 seconds
for a change and seven seconds for the catalog, and unsubscribes on close or
thread change. Audit records include operation, outcome and latency. Metrics use
only fixed operation/outcome labels, never model or thread identifiers.

A timed-out request may still execute at the provider. There is no automatic
retry: pending intent survives errors and process restarts, and settings remain
read-only until an operator reconciles the runtime. Reload alone does not clear
this state. Settings notifications do not carry operation IDs, so they cannot
confirm an uncertain operation or overwrite explicit Orkestr settings. Only the
correlated RPC acknowledgement confirms the operation. Notifications for legacy
threads without explicit Orkestr settings still populate metadata under the same
lock. Automatic recovery from an uncertain mutation is intentionally unsupported.

The opt-in WhatsApp debug footer adds weekly reset time alongside remaining
capacity. Existing `ORKESTR_WHATSAPP_DEBUG_FOOTER`, `WA_DEBUG_FOOTER` and
`WA_APPEND_DEBUG_FOOTER` flags, per-message/binding suppression and contained-user
suppression still apply. Reset timestamps accept seconds or milliseconds; invalid
or missing values are omitted. The owner's saved IANA timezone is read through
the scoped onboarding profile with a 250ms deadline, with explicit UTC fallback.
The owner timezone is transient. Footer replacement prevents duplicate footers.
This only displays provider quota reset information; it never resets quotas.

Validation covers catalog normalization/cache/deadlines, live pair validation,
owner and policy denial, concurrent changes, explicit metadata persistence,
uncertain-operation fencing, notification ordering, command handling without
turn creation, executable UI lifecycle/selection/error tests, and reset timestamp,
timezone and suppression cases. Tests use isolated storage and fake runtimes;
no provider settings or external messages are changed.
