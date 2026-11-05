# Root Fast process observation

The Root-only `codex_service.fast_sampler` module joins an authenticated exact-input
Core Fast receipt with live process-tree and Root-created pipe evidence. It does
not execute a provider, send a message, change Core or Root policy, or issue any
inference/approval capability. Production cutover remains independently gated.

The caller must obtain the version-one receipt from
`POST /api/v2/conversations/{id}/fast-runs/lookup`, using the protected service
client and the exact admitted `input_message_id` and `input_event_id`. The module
does not authenticate caller-provided JSON or fall back to Deep/latest/native
session searches. The authenticated private adapter is responsible for that
HTTP boundary.

`capture(package, fast_receipt, output_directory)` requires an already validated
split `Package` and an existing Root-owned mode0700 output directory with protected
ancestry. It selects only the matching protected Fast launch journal: owner,
conversation, session, provider, incarnation, window/generation and metadata setup
generation. Claude uses launcher role `claude` with setup role `fast`; Codex uses
launcher role `fast`. A stale, exited, ambiguous or missing live launch is unknown.

Root observes the actual original manager/server/proxy/broker PID/start/UID
relationships, pinned executable device/inode and digest, and NNP on proxy,
broker and observed native. The proxy must still belong to the original server;
the broker and server must still belong to the Root manager. A bounded broker
descendant walk must find exactly one live pinned executable holding fd0/1 with
the exact Root-owned mode0600 pipe pair from that launch.

Fast has no qualified original-native PID registration. The observed process PID
is therefore **metadata only**: snapshots always set
`original_native_pid_registered=false` and `native_pid_claim=null`. A native
session ID never becomes a PID claim. This proof covers the Root/Core process
tree and pipe custody only.

Capture publishes the first witness as a Root-private mode0600 file named by the
Core run ID, retaining its package manifest, launch identity/hash and kernel
observations. It never replaces a witness with another actor. A journal alone
cannot produce a live observation; sampling after the actor exits returns
unknown. Callers should watch during an already authorized canary rather than
generate additional messages to obtain a sample.

`verify(receipt_path, completed_fast_receipt, package=current_package)` checks the protected witness and
the exact original lineage fields. Only Core `succeeded` plus a non-null acceptance
event yields `status=accepted`. A real observation can join that later Core fact
after its processes retire; the verifier does not pretend they remain live.
Production acceptance also requires the same canonical package root and full
manifest digest, including private runtime configuration. The original Root
manager and Core PID/start/executable relationship must remain live, and that
Core must still own the configured loopback HTTP listener. An older package,
private configuration or Core incarnation cannot qualify the current service.
Without `package`, the same API offers factual postmortem diagnostics with
`status=diagnostic` and `package_bound=false`; it never grants production acceptance.
The consumed dispatch can still retain its durable `delivery_unknown` marker;
that marker is not a substitute for Core acceptance and is not required to
change to `reserved` at completion.
Changed inputs, scope, provider, binding, window or incarnation remain unknown.
The result proves no external delivery or business effect and grants no authority.

The disposable `v2/tests/identity_split_fast_sampler_http.py` harness uses the
existing three-input managed-host Deep/Fast fixture and the actual HTTP lookup.
It emits no real provider request or additional canary message. Its snapshots are
verified inside the fixture before cleanup; the private report retains the
synthetic evidence and hashes.
