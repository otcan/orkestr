# Independent attachment verifier boundedness review

Reviewed exact UI `801116684c635076d6fde22a9318fc186210c39d` against the prior pure-client checkpoint. No transport, storage, browser, or roundtrip qualification is implied.

Independent execution from an exact Git export passed all 15 supplied Node tests. The unchanged original 100,000-empty-chunk probe, whose SHA-256 is `aa744841e75f67f3e4aab0559f92b8e483b4825b860a23f832d8f38f7a5d399d`, now exits with `Attachment read budget exceeded`. The original checkpoint had accepted that probe. Its unchanged top-level caller does not catch the refusal, so exit status 1 is the expected negative result; it does not print its success-only counters.

The verifier allocates one declared-length buffer, bounded by the validated 16 MiB limit, copies each chunk immediately, and permits at most 65,536 reader calls including EOF. This bounds retained allocation and repeated empty-read work. Supplied regressions cover empty floods with zero- and one-byte declarations, one-byte fragmentation, no hashing after refusal, reused mutable chunk copying, and the 16 MiB boundary. Cancellation remains in `finally`.

No bounded source blocker remains for this pure helper. Valid streams fragmented beyond the read budget can refuse, as documented. A future transport still needs its own timeout, abort, authorization, and encoding guarantees; this helper does not make a stalled reader or cancellation promise terminate.

Private exact-export stdout/stderr and unchanged probe are retained under `/var/tmp/orkestr-attachment-review-80111668`. No browser, provider, backend, or build was run for this review.
