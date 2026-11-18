# Accepted result history

Canonical read route for server composition: `GET /api/v2/conversations/{conversation}/accepted-results?after_sequence=0&limit=20`. Strict nonnegative exclusive `after_sequence`; limit 1..50, default 20. Original current browser credential is passed to `Store::accepted_results_authenticated(credential, conversation, after_sequence, limit)`. No owner selector or supervisor authority is accepted. Existing authenticated protected payload route remains the text reader.

`AcceptedResults { conversation_id, results, next_after_sequence }` contains ascending acceptance event sequence rows. Each `AcceptedResult` has `run_id`, `completion_event_id`, `acceptance_event_id`, `acceptance_sequence`, nullable `payload_id`, and `payload_removed`. The reference is the last progress payload of the exact run strictly before its canonical completed proposal. No payload means no recorded output, not an empty assistant message. Removed payloads retain their exact reference with `payload_removed=true`; clients must not restore cached text. Protected payload reads remain authoritative if removal occurs after listing. These are accepted result records, never canonical assistant messages or new terminal events.

`next_after_sequence` is the last returned sequence only when another row existed at the same read cut. Empty pages use null. Repeated reads do not certify current execution readiness. Scope/authentication failures refuse; no cross-owner output or credential is returned. No schema change, automatic acceptance, dispatch, or replay occurs.

## Newest page first

`GET /api/v2/conversations/{conversation}/accepted-results?before_sequence=9223372036854775807&limit=50` reads the newest `limit` rows with an acceptance sequence strictly below `before_sequence` (`Store::accepted_results_before_authenticated`), still in ascending order. `before_sequence` is 1..=i64::MAX and cannot be combined with `after_sequence`. The page never carries `next_after_sequence`; a full page means older rows may exist below its first row, read with that row's sequence as the next `before_sequence`.

The web chat keeps only the newest 100 replies, so it opens with at most two such pages instead of following forward pages of 20 from the start (one sequential request per 20 replies of history). A server that answers a newest-first read with a forward page (or refuses it) is detected by the page check, and the chat then reads forward as before.

The same applies to conversation snapshots: `GET /api/v2/conversations/{conversation}?before=9223372036854775807&limit=100` returns the newest 100 visible messages below `before` (at most the watermark) with `last_sequence` as the watermark the live stream continues from, and no `next_cursor`.

## Run updates

`GET /api/v2/conversations/{conversation}/updates?after_sequence=N&limit=100` (or `before_sequence=M&limit=100`, the newest page below `M`, never with a forward cursor) lists every canonical progress payload of the conversation's Deep runs in event order: `RunUpdates { conversation_id, updates, next_after_sequence }`, each `RunUpdate { run_id, payload_id, sequence, observed_at_ms, payload_removed, final_answer }` (`Store::run_updates_authenticated` / `run_updates_before_authenticated`). `sequence` is the progress observation's conversation event sequence and the page cursor; `limit` is 1..=100. `final_answer` marks the payload an accepted result names (the last progress before the run's accepted completion). The route needs the owner's browser session, like accepted results; texts are read with the same payload routes. Health lists `run_updates_v1`.

The web chat shows every update as its own message at its event, marked Update, and the accepted reply as the Final message (owner decision 2026-11-18): nothing is replaced in place. It reads the newest three pages when a chat opens and then forward from the newest update whenever the live stream advances. An update whose payload an accepted reply on screen names is never shown twice, even when it was listed before its run was accepted. While the current run works, a line under the last update says so.
