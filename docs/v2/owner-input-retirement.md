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
