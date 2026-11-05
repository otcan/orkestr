# Authenticated input provenance

The message author's label and the request's authentication origin are separate.
A delivery adapter can legitimately submit an owner, member or automation label;
that label alone never proves an authenticated human app request.

The messages endpoint revalidates its exact credential and owner inside the
admission write transaction. For a fresh input, migration 0088 records immutable
`message_request_sources` metadata: message, owner, session kind, credential hash,
optional service credential and recording time. No raw credential is retained.
Message, event, inbox, author and authentication metadata commit or roll back
together, including provider-generation fences. Expired, revoked or mismatched
owner credentials cannot admit a replay either.

Existing messages are not backfilled. Replaying an identical input never adds
origin metadata or promotes a machine/legacy source to browser origin. A session
rotation does not rewrite historical evidence. Internal/timer admission ports
without authenticated HTTP context remain unattributed by this ledger.

Session kinds are server-derived, not accepted from request JSON:

- `browser`: an ordinary browser login session.
- `service_browser`: a separately issued automation credential using cookie/CSRF
  API transport. Cookie transport alone is not evidence of a human request.
- `machine`: a machine or internal execution-window credential.
- `legacy`: an older session whose origin cannot safely be inferred.

This metadata proves the authenticated request channel, not the meaning of text
or the scope of an agent's later requested action. Approval consumers must read
the actual accepted input and keep an agent's summary distinct from owner text.
WhatsApp input still needs the transport's independently checked principal proof.

Core must be protected from executor writes before this ledger can establish
trusted authority. Unattended clients that historically used ordinary browser
login must migrate to service credentials before treating a browser source as
an app-owner provenance signal. Do not enable approval shortcuts solely because
this table exists. Identity separation, client migration and negative forgery
acceptance remain deployment qualification requirements.
