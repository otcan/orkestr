# Retire an exact unstarted owner input

An authenticated owner can permanently retire one obsolete or duplicate input:

```text
POST /api/v2/conversations/{conversation_id}/inputs/{message_id}/retire
```

```json
{"request_key":"retire-duplicate-1","reason":"Obsolete duplicate; never replay"}
```

The route requires the ordinary owner browser session, matching Origin and
Host, and CSRF token. The message must be an owner input in that conversation.
It must still be queued, with no claim, prior run, open window membership or
pending window intent. Otherwise the operation refuses without changing input.

Migration 0070 adds a distinct terminal inbox state, `retired`, and an immutable
receipt containing the owner, exact message/event IDs, sequence, reason and
timestamp. Existing messages, events, closed-window history, observations and
delivery receipts remain intact. Retirement creates no message, reply, window,
run or dispatch permission, and makes no delivery claim.

The same request key and semantics return the same receipt with `duplicate=true`;
changing the message or reason under that key conflicts. There is no unretire
operation. Deep claims, stale Fast locators, window admission and pending-queue
admission all retain the terminal fence after Stop, new input or a process
restart. Fresh inputs remain independently eligible.

## Settle a stale automatic result (ORK-798)

Some automatic results (host tool results fenced to the Deep turn that asked
for them) were left in a window that has since closed, in a shape the retire
route above refuses:

- claimed by a Deep session whose claim lapsed while the window closed (the
  reconciliation released the input but kept it claimed);
- still queued after its own Fast run finished.

Neither can ever run: Core claims only inputs of the current window, and only
a queued result without any run is queued again. Both still count as eligible
input, so `/held-inputs` reports `eligible_input_available: true` (the web UI
then shows "New input is queued separately…"), and steering orders behind
them. The owner settles one exact input:

```text
POST /api/v2/conversations/{conversation_id}/inputs/{message_id}/settle-stale
```

```json
{"request_key":"ork798-settle-20261113:<event_id>"}
```

The route needs the owner's own browser session (Origin, Host, CSRF). An
adapter service session or a machine token is refused. The input must be an
automatic result with a source fence whose window queue intent was dispatched
to a window that is now `closed`, outside every window that is not closed,
never admitted, with no fixture run and no run other than a finished Fast run
(`succeeded`, `failed` or `cancelled`), and either claimed with a lapsed claim
or queued, unclaimed and with a finished Fast run. Anything else, including a
result still in line for the dispatcher, refuses with 409
`stale_input_settlement_conflict` and changes nothing.

The input becomes `retired` with the same immutable receipt as above and the
fixed reason `operator_settled_stale` (201; the same key returns the same
receipt with 200, a changed decision under a key conflicts). Nothing is
replayed, sent or created, the Fast run and the window history stay as they
were, and a Stop hold stays a hold: the held list keeps listing a held input,
while `eligible_input_available` no longer counts it.
