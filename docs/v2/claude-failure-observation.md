# Correlated Claude error observations

Claude's native `error_during_execution` result has `errors[]`, without the
success-only `result` string. The broker accepts this bounded error shape only
for the current consumed input and exact native session, with a fresh canonical
terminal UUID. It strips every error string and metadata field and passes the
existing Runtime `is_error: true` failure contract with an empty result.

This yields a failed run, never progress, successful completion, owner
acceptance, or confirmed Stop. The separate issued-control path still requires
its exact interrupted terminal and owned-tree reaping. Missing/foreign input
correlation, terminal replay, malformed/oversized errors and unknown fields
remain refused. Setup errors without a consumed input correlation cannot be
attributed to an execution through this path.

The existing success and interrupt codecs are unchanged. Accepted assistant
UUIDs are remembered in a bounded set only to reject their reuse as an error
terminal; exhausting that set disables error acceptance without changing
ordinary assistant delivery.

Focused checks: `python3 -B -m unittest discover -s v2/provider-broker -p
'test_claude*.py' -v`. Ordinary HTTP failure tests additionally prove that the
redacted native error commits `Failed` without a payload, Stop or acceptance.
