# Public UI asset revalidation

Previously every UI asset used `no-store`, forcing a fresh JS/WASM transfer on
reload even when the build was unchanged. The startup snapshot now computes a
SHA256 ETag once per asset and sends `Cache-Control: public, no-cache`.
Browsers can retain the bundle and validate it on reuse. A matching GET or HEAD
returns 304 with no body; changed content returns 200 and a different validator.
The HTML entrypoint also revalidates, so it cannot silently remain on an old build.

This policy applies only to explicitly loaded public build assets. API data and
authenticated resource readings retain `no-store`. Existing path refusal, MIME,
size bounds and immutable in-memory serving are unchanged. No request-selected
disk reads, new dependencies or automatic asset downloads are introduced.

Conditional requests follow the weak comparison semantics of
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).
The storage/revalidation policy follows
[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.4).
Malformed or oversized validator lists fall back to a full response. Hashes are
of the representation bytes; this server does not generate compressed variants.

Validation covers weak/strong/wildcard/list validators, changed builds, zero-body
304 responses, HEAD semantics, API authentication/cache boundaries, and actual
HTTP through the composed router. Browser download behavior through the normal
production access path remains a separate release measurement.
