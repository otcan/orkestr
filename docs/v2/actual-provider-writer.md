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
