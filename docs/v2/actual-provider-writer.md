# Actual provider stdin writer checkpoint

The owned Codex path requires the broker FD protocol from source `1008d373`.
The fixed launcher inherits only a private socketpair endpoint at fd 3. Runtime
accepts exactly one write-only FIFO descriptor with the marker
`provider-stdin-v1`; malformed transfers close all received descriptors.
The broker closes its writer after transfer. No pathname or credential locator
is exchanged.

`BrokerPrepared` registers correlation before Runtime writes native bytes.
Runtime waits outside SQLite, then writes at most 16 KiB per call inside the
current metadata or execution fence. The offset advances only after the fence
returns successfully. A failed fence or uncertain commit quarantines the child
and closes the writer; no suffix or complete-frame retry is authorized. A
coalesced initialized reply cannot advance setup before the actual write.

Actual ordinary Store tests cover the complete same-child synthetic broker
flow, durable cancellation after preparation but before native turn bytes
(zero delivery), and cancellation after an observed partial prefix (no suffix,
newline, parsed turn, or redispatch). These are synthetic owned processes,
not subscription execution acceptance. The prefix remains uncertain work.

HTTP Stop imports the transaction-time credential guard from Core `d791f1ef`.
The exact original namespaced browser credential is checked before fresh and
historical Stop receipts. Origin and CSRF remain HTTP requirements.

The provider interrupt/control write composition is still pending. A durable
Stop intent and refused execution write do not establish a provider Stopped
observation. Real-provider activation remains held until that composition and
its independent review pass.

## Post-action rollback regression

The opt-in runtime unit test
`post_native_suffix_rollback_quarantines_without_offset_retry_or_reissue`
uses Core's `ExecutionFenceAfterActionRollback` facility from
`603efd12703e8fd1a3c02a9a8406b116defe93db`. A test-only retained reference arms
exactly the attached child's StoreFence after `BrokerPrepared`, avoiding setup
and attachment callbacks. This reference and arming method are absent from
non-test builds, including feature-enabled library builds.

The synthetic native reader records a nonempty incomplete prefix. The fence
then rolls back and returns `Unavailable`; no offset is acknowledged, further
pump/flush calls refuse, and the child is quarantined. Reopening the ordinary
store reports reconciliation rather than issuing another reservation or
capability; no completion or acceptance candidate is invented. This is a
deterministic injected pre-COMMIT rollback after a real bounded write, not an
OS/disk COMMIT-failure simulation. Sealed interruption remains a separate gate.
