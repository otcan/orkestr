# Browser Stop request route

The server exposes `POST /api/v2/conversations/:id/stop`. Its canonical input
`ExecutionControlRequest` and output `ExecutionStopReceipt` come from Core.
The request is:

```json
{"run_id":"00000000-0000-4000-8000-000000000001","expected_revision":4,"expected_control_revision":3,"request_key":"stop:example-1"}
```

The original revision is the conversation status revision, not a lease generation.
The optional control revision must come from that exact run's status. It tolerates
intervening progress and sibling changes while preserving control-state CAS;
future conversation revisions refuse before any cancellation. Omitting the
control revision retains the legacy strict conversation-revision comparison.
The browser must retain the exact run, both revisions and request key after uncertain
transport failure. An identical replay returns HTTP 200 and the original durable
receipt, including its original revision. Reusing the key with changed revision
conflicts. A new request requires the current control precondition. Unknown input fields and
missing/invalid run identity refuse; a queued projection without a run grants no
control identity.

HTTP 200 contains schema_version, conversation_id, run_id, request_key,
requested_revision, revision and outcome. Outcomes are `not_dispatched` or
`requested_unknown`; neither asserts confirmed interruption of a running process.
No success receipt is synthesized. All responses retain existing no-store policy.

The route explicitly requires a browser cookie, exact configured Host/Origin and
`x-orkestr-csrf`. Bearer-only or mixed cookie/Bearer requests cannot operate it.
Missing authentication is 401; origin/CSRF refusal is 403. Invalid input is 400;
missing or unauthorized scope is 404; revision/content conflict, expired/fenced
execution or busy state is 409. Unavailable authority/storage is 503. Error
responses carry the existing code/message/request_id/retryable envelope; clients
must not infer cancellation from any error or timeout.

Trusted server composition can install an already authorized bound Store using
`AppState::with_execution_store`. Default server construction installs none and
returns 503 for an otherwise valid Stop request. Browser IDs never authorize a
supervisor or select its namespace. Core revalidates every supplied identity and
revision against the bound handle. The ordinary configured factory also registers
each owned Deep and Worker transport and publishes Core's private control receipt
through its exact mailbox. A public receipt still proves durable intent only;
correlated provider terminal evidence is required separately for confirmed Stop.
Steer has no success route in this checkpoint.

`execution_stop` is an actual HTTP test using public ordinary Store APIs, two
synthetic bound-server cases and no provider. It covers both outcomes, identical
retry, changed-key-content conflict, scope refusal and cookie/CSRF/Host/Origin
refusals. This is not live-provider interruption acceptance.
