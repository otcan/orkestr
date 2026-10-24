# First Fast response in WhatsApp

For interactive inputs with progress updates enabled, the adapter exports the
input's own first completed Fast reply as one progress message. It waits only
until five seconds after intake, so an already-ready Deep final wins without
an extra acknowledgement. A Fast reply arriving after that window is eligible
on the next normal one-second pass; there is no additional five-second wait.
The provider's time to produce Fast output is still part of delivery latency.

The first export and its one-shot marker are persisted together. Restart and
lost acknowledgement keep the same export. Later Deep progress uses the same
spacing clock and is limited to one per minute, within the existing per-input
export cap. Fast NO_REPLY is silent, and a ready Deep NO_REPLY follows the
ordinary final suppression path. Operational timers keep their existing reply
and digest policy. This path does not accept a Deep proposal or replay input.

Measure actual sends after the adapter deployment boundary:

```sh
python3 -B -m v2.compat.v1_runtime.latency --ledger /private/binding.sqlite3 --after-ms 1800000000000
```

The command opens the ledger read-only and emits metadata only. Latency starts
at adapter intake (`queued_at`) and ends at the first known provider send
receipt, whether progress or final. It does not use export creation or local
acknowledgement time as a substitute for sending. Late genuine progress send
receipts still count after supersession. Absorbed burst fragments and
operational posts/timers are excluded; silent NO_REPLY and missing/uncertain
send receipts are reported separately. Percentiles use nearest rank, include
sample count, and flag fewer than twenty samples. A provider send receipt does
not establish a recipient read or delivery acknowledgement.
