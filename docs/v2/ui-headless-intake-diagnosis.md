# Headless durable-intake assertion

Hosted run 39187128261 at source 24ae02b timed out after 30 seconds waiting
for the body text `Input durably accepted`. It reached login and the composer.
The retained log contains no failing DOM or network capture. The original
failure remains evidence; this change neither reruns it nor establishes its cause.

Conversation's Send callback and history synchronization/replay callbacks write
one status signal (`apps/ui/src/views.rs`). A successful receipt notice can
therefore be replaced by a history notice before the browser assertion observes
it. This is a source-supported race hypothesis, not a proved diagnosis of that run.
A later passing run alone does not resolve the missing evidence.

The CI assertion now registers its response waiter before Send and requires a
fresh 202 response, an accepted canonical receipt with IDs and positive sequence,
and an authenticated canonical snapshot containing exactly that owner message,
sequence and text in the global conversation. It still reloads and requires the
message to render, checks cookie resume, refuses a CSRF-less write and verifies
logout. A transient status sentence is no longer the persistence oracle. There
are no increased timeouts, retries or product changes.

On failure the runner emits its stage, bounded route/status observations,
composer/login presence, rendered message count and page-error count before
cleanup. It excludes headers, cookies, input values, response bodies and server
output. These diagnostics distinguish missing POST, refused admission, history
failure and reload rendering failure without exposing authentication material.

Local validation: eight Node assertion cases pass, including missing/duplicate
admission, foreign scope, wrong identity/text and insufficient watermark refusal;
runner syntax and diff checks pass. No browser, lease, provider, compilation or
hosted execution was performed for this checkpoint. Hosted qualification remains
pending at the new exact head.
