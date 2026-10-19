# Independent pure attachment review

Reviewed exact UI `75ac45a04fd7987774d7ce959c170176a5565dfa` against Core
`9788ef14d0d86ecdaa5dde14522761194064cfb4`. The supplied twelve Node tests
passed independently from an exact Git export. No transport, browser, storage,
roundtrip or authority qualification is inferred.

Metadata validation matches the pinned schema, UUID identity, count/aggregate
limits, UTF-8 filename rules, restricted media type and lowercase SHA-256.
The selected reference is copied and frozen before asynchronous work. Exact
length/hash checks and current-scope checks surround reads and hash completion;
tombstones refuse supplied bytes. Presentation does not enable save. Immediate
abort and save-time authorization remain future transport responsibilities.

## Open boundedness finding

`verifyBytes` pushes a copied typed array for every chunk into an unbounded array,
including zero-length chunks. Its 16 MiB byte cap does not bound chunk count or
allocation overhead. An independent synthetic probe supplied 100,000 empty
chunks, one content byte, then EOF for a one-byte manifest: it returned verified
after 100,002 reads and cancelled the reader once. This proves the missing
chunk/no-progress bound without a large-memory or browser stress test. Positive
one-byte chunks can likewise create many retained allocation objects before the
byte ceiling is reached.

UI was notified to repair accumulation under its existing ownership, using a
bounded buffer and explicit no-progress/read handling or equivalent controls.
The pure consumer's bounded-stream claim remains held pending that successor.
No hash/scope bypass or live attachment exposure was demonstrated. The twelve
passing supplied tests do not cover this case. No production source was edited
by Verification.
