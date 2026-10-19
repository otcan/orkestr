# Closed Claude rate-limit telemetry

Claude Code 2.1.295's subscription `rate_limit_event` can arrive before native
initialization, during a turn or after its terminal. A strict adapter must
validate and discard these documented native fields without interpreting them
as execution, control, credential, retry, purchase or billing instructions.

The native executable reviewed has SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`.
Its `rate_limit_info` schema begins at byte 207559936. The selected fields are
forwarded by `wrr` at 215718123, wrapped as `rate_limit_event` by `dqo` at
222683805, and used by the headless rate-limit listener at 241325327. These
constructors are separate from the native summary structure that defaults its
missing reset time and rate-limit type to null. The emitted event omits absent
fields; the event schema does not declare nullable numeric fields.

The additional closed shapes are:

| Field | Accepted metadata shape |
| --- | --- |
| `overageInUse`, `overageEnabled`, `rateLimitGraceActive`, `canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod` | Boolean |
| `surpassedThreshold` | Finite nonnegative number |
| `limitScope` | `service`, `channel`, or `group_pool` |
| `errorCode` | `credits_required` |
| `overagePeriodMonthly`, `overagePeriodChannel` | Exactly one finite nonnegative `utilization` number |
| `rateLimitType` | Existing enum plus `seven_day_overage_included` |
| `unifiedWindows.seven_day_overage_included` | Exactly `utilization` and `resetsAt`, using the existing finite nonnegative numeric checks |

Utilization may legitimately exceed one according to the native schema. The
two period fields are described there as surface-specific spend-cap metadata;
discarding them does not activate that surface or any spending behavior.
Existing numeric checks and existing bounded disabled-reason strings remain
unchanged. Absent fields stay optional; explicit null, booleans in numeric
slots, nonfinite or negative numbers, wrong enum values, extra nested keys and
unknown top-level fields refuse.

The outer channel still requires its exact current session, initialized
adapter and consumed input; validates a unique canonical telemetry UUID; and
applies the same 128-record, per-frame and shared raw-byte limits. Even before
native init or after a terminal, telemetry cannot advance readiness, provide
text, supply a terminal, acknowledge cancellation or authorize another input.
Its data is never forwarded to Runtime. The genuine cancellation ACK and
interrupted terminal remain independent evidence.

A source-shaped regression fails the predecessor's telemetry key guard. Tests
cover each optional field, all metadata statuses, finite/type/closed-shape
refusals, unknown authority fields, wrong scope, duplicate identity and shared
budgets. This is an independently established compatibility correction: no real
provider failure is attributed to these fields, and no real-provider lifecycle
qualification follows from the synthetic tests.

The accompanying numeric audit also checked the supported system thinking
counts (native schema byte 207704350), result duration and turn counts
(207623860), cost (207623946), and queued/result/safety counters
(207624158 / 207627554 / 207624070). Their pinned shapes contain no nullable
numbers: integer counters and finite numeric cost are already accepted. The
separate partial-stream audit is recorded in
[claude-thinking-estimate.md](claude-thinking-estimate.md). None of those
existing guards is relaxed by this telemetry correction.
