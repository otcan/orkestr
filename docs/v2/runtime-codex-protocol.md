# Codex protocol increment

`orkestr-runtime::codex_rpc` owns bounded request/reply correlation for the
installed Codex 0.163.0 stdio protocol. Shapes were checked against the installed
binary's `app-server generate-json-schema` output, without inference or reading
credential/session files.

Initialization validates the response before returning `initialized`. A separate
`account/read` explicitly disables token refresh and requires the subscription
account route; API-key, Bedrock, missing, and unknown account routes are refused.
Account contents are not retained. This status is not durable execution authority.

Persistent `thread/start` follows subscription status. Each role needs a distinct
connection and native session. The initial slice requires read-only sandbox,
network disabled, and no provider approval escalation. The native locator is
exposed only to trusted server composition for Core readiness confirmation.
There is no turn submission method in this checkpoint. No provider completion
is interpreted as verified success.

The next composition boundary is a Core-issued, non-cloneable consumed dispatch
capability carrying the durable input and bound native identity. Containment's
resource authority and current-fence callback must not substitute for that
single-use durable dispatch grant. Runtime will compose those with the ordinary
Store authority API; fixture authority cannot be used for production.

Validation: six protocol tests cover ordering, correlation, unrelated
notifications, subscription-only selection, bounds, and native session policy.
These are protocol tests, not real provider lifecycle acceptance. The installed
CLI reported Codex 0.163.0 and Claude 2.1.295; Claude was version-only. A safe
connector status request was unavailable to this worker, so no subscription
inference or live-session attachment was attempted.

Readiness correction after independent review of the initial checkpoint: the
pending thread request retains its expected trusted workspace. Both response
`cwd` and `thread.cwd` must match that exact path, and `thread.ephemeral` must
explicitly be false. Missing, malformed or inconsistent fields refuse readiness
without publishing the native locator. Request paths must be normalized absolute
paths; actual canonicalization and symlink containment remain the trusted
Executor configuration's responsibility. A valid response control is required
alongside refusal tests. The two independent refusal probes from review commit
`17543337` were run unchanged against this correction and passed (author rerun).
