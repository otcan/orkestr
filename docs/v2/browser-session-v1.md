# Browser sessions

Browser authentication is `POST /api/v2/browser/session` with the existing username
and password JSON. Require an exact configured Origin and Host, including at login;
no forwarded header is trusted. The response contains `csrf_token` and
`global_conversation_id`, never the session cookie value. Credentials bootstrap
login, so login itself requires Origin/Host rather than a pre-existing CSRF token.
Successful reauthentication rotates and revokes the supplied previous cookie.

The host-only `orkestr_v2_session` cookie is HttpOnly, SameSite=Strict,
Path=/api/v2, Max-Age=43200, with Secure when the configured origin is HTTPS.
The database enforces expiry independently of the cookie lifetime. Cookie sessions
are stored in a separate hashed-token namespace; cookie values cannot authenticate
as machine Bearer tokens, and machine tokens cannot authenticate as cookies.
Ambiguous cookie plus Authorization authentication and duplicate session cookies
are rejected. Only hashed session material is stored; no schema change is needed.

GET `/api/v2/browser/session` requires the exact configured Host and returns
Cache-Control: no-store with the current session's CSRF token and global conversation ID. Browser writes, including DELETE on that path for logout, require
the cookie, exact Origin/Host and `x-orkestr-csrf`. The CSRF token is a domain-separated
SHA-256 derivation of the unpredictable cookie token, compared using fixed-size
hashes. An expired or revoked cookie cannot write or retrieve session metadata.
Logout revokes the stored session before returning 204 and a Max-Age=0 cookie.
No cross-origin response access or CORS allowance is introduced.

`POST /api/v2/machine/session` is the explicitly named machine Bearer login path;
`POST /api/v2/session` remains its compatibility alias. Machine responses retain
`token`, `token_type`, `expires_in` and `global_conversation_id`. Existing machine
requests need no ambient cookie or CSRF token. Bearer issuance (including the compatibility alias) and authenticated Bearer use
reject every request carrying an Origin header, including the configured origin
and null. Browser requests must not use machine credentials or Bearer authority. Browser clients must use the browser path rather than persist
machine tokens in local storage.

The server accepts explicit `ORKESTR_V2_ORIGIN` for an operator-configured HTTPS
origin behind a trusted same-origin TLS proxy; otherwise origin is its loopback
HTTP bind address. Origin validation does not configure TLS or trust proxy headers.
The proxy must preserve the configured Host. No production listener or deployment
is changed by this source slice.

HTTP regression coverage includes missing/wrong CSRF, missing/foreign Origin,
wrong Host, rejected-write row preservation, successful intake, logout/revoked-token
reuse, cookie rotation, expiry, duplicate cookies and machine/browser separation.
A Rust regression checks HTTPS Secure and host-only cookie attributes. Browser UI
boot and independent security review remain separate acceptance gates.
