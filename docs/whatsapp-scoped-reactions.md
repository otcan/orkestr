# Scoped WhatsApp reaction snapshots

The existing delegate read routes return current reaction snapshots:

- `GET /delegate/chats/:chatId/messages`: each message includes `reactions`
  and `reactionsStatus`.
- `GET /delegate/chats`: each paged chat includes `lastMessage.id`,
  `lastMessage.reactions` and `lastMessage.reactionsStatus`. This lists reactions
  on the last message only, not all reactions in the conversation.
- Existing native account chat history, including paged history, includes the
  same fields. Existing account/recipient/read permissions still apply.

Each reaction includes `messageId`, `emoji`, `fromMe`, `origin` (`us`, `them`,
or `unknown`), `reactionId`, `timestamp` and `ack`. Ownership comes from the
individual provider reaction ID or exact authenticated own identity; the
aggregate `hasReactionByMe` flag does not identify every sender. Unknown PN/LID
mappings and contradictory identity evidence remain unknown.

`reactionsStatus` is `available`, `partial` or `unavailable`. Failure, unsupported
message models and timeouts are not reported as verified absence. Reads use
the supported `Message.getReactions()` API, never mark seen and perform no new
contact lookup. Four concurrent calls and a three-second page budget bound
provider work; a timed-out worker stops rather than piling up browser calls.
This is a current snapshot, not a complete historical reaction event stream:
removed or changed reactions cannot be reconstructed from it.

## Optional reaction writes

The dedicated delegate credential can use `POST /delegate/react` only when its
existing private delegate configuration explicitly sets `allowReactions: true`.
The default is disabled. Do not grant a coordinator bearer to a delegated thread.
No router registration, recipient expansion or read-all permission is needed.

```json
{
  "to": "15550000002@c.us",
  "messageId": "false_15550000002@c.us_EXAMPLE",
  "emoji": "👍",
  "requestId": "reaction-example-1"
}
```

Only a single Unicode RGI emoji is accepted. Removal and arbitrary text are not
supported. Both the supplied provider message ID and the retrieved message's
remote chat must match an approved direct chat. Unmapped LID message IDs fail
closed; do not rewrite IDs to force a match.

The operation is serialized with existing transport work and reserved in a
separate `delegate_reaction` table in the same durable journal. It never enters
the text-send table, consumes a new-recipient slot or establishes prior text
contact. Reaction effects have a separate limit of 20 per rolling 24 hours and
at least 60 seconds between operations. Existing identical own reactions are
recorded as `unchanged` without a provider call or a claimed send receipt.

The library's `react()` returns no acceptance receipt. A new own reaction with
the correct parent, recent timestamp, previously unused reaction ID and server
ACK is required for `state: confirmed`, `acceptance: provider_ack`. This does not
claim delivery/read. Otherwise the state is `uncertain`, including timeouts and
crash-interrupted operations, and all further writes to that message are held.
There are no automatic retries. Identical request IDs dedupe; changed payloads
conflict. Original reaction IDs cannot be reused for another confirmation.

`GET /delegate/reactions?state=uncertain` exposes only that delegate's journal.
After independent provider inspection, an operator with the existing coordinator
credential can explicitly reconcile via
`POST /coordinator/delegate-reaction-resolve` with `delegate`, `requestId`,
`outcome` (`confirmed` or `not_sent`) and `providerId` for confirmed acceptance.
The old request ID stays consumed even when resolved not sent. Raw journal
records remain intact. Reconciliation never sends a reaction.

## CLI and activation

`scripts/whatsapp-delegate-cli.mjs` supports existing read/text operations plus
`react CHAT MSG EMOJI --request-id ID` and `reactions [--state STATE]`.
Set `ORKESTR_WA_DELEGATE_URL` to the existing loopback HTTP bridge and
`ORKESTR_WA_DELEGATE_TOKEN_FILE` to the existing dedicated delegate credential.
The CLI refuses redirects and non-loopback destinations and never prints its
credential. Personal CLI wrappers/configuration belong in the private overlay.

Release through the normal release train. Read fields become available after
the affected bridge(s) use the reviewed source. Enable writes only for the
explicitly approved existing delegate in its private configuration; verify
`GET /delegate/health` reports `reactionRead: true` and the intended
`reactionSend` value. Do not test by sending to an arbitrary contact or restart
a bridge during an active outbound operation. A read-only verification against
an already approved chat is sufficient; reaction sending needs an explicit
specific action. This source change does not install itself or enable writes.

Rollback retains the additional table and all uncertainty/acceptance records.
Disable `allowReactions` and stop issuing reaction commands first. Older builds
that reject this new configuration key require removing the key when rolling
back; do not restore an old journal snapshot or restart interrupted sends.
