"""Map one V1 group's participant policy into an adapter binding's `participants`.

Read-only. V1's scoped group relay admits a non-owner author only when all of
these hold, so the mapping lists exactly the people who satisfy them and never
more:

* the relay config has a `participantAuthors` rule for the group's chat and
  thread, and the author's phone JID is in its `ids` (a LID author is resolved
  to its phone JID by the relay at runtime);
* the V1 thread binding has `allowOtherPeople: true`, `mirrorToWhatsApp: false`
  and lists that phone JID in `authorizedContactIds`;
* the id is not the linked account (`ownChatId`) or an additional owner author
  (those are the owner, not participants) and is not blocked on the binding.

Each mapped person becomes role `member` with a label from the binding's
`additionalParticipantLabels` (else the phone number). Bindings that use V1's
participant identity v2 are refused: map those by hand. V1 still runs its own
participant check before forwarding, so the adapter list is a second gate.

    python3 -m v2.compat.v1_runtime.participant_policy \\
        --relay-config all-threads.json --v1-threads-db threads.sqlite --thread-id ID
"""
import argparse
import json
import sqlite3
import sys
from urllib.parse import quote

from .config import label as valid_label, participants as valid_participants


class PolicyError(ValueError):
    pass


def _ids(value):
    return [v for v in value if isinstance(v, str) and v] if isinstance(value, list) else []


def _label(labels, *ids):
    for key in ids:
        value = labels.get(key) if isinstance(labels, dict) else None
        if isinstance(value, str):
            value = " ".join(value.replace(":", " ").split())[:64]
            if value and value.isprintable():
                return value
    return "+" + ids[0].split("@", 1)[0]


def map_policy(relay, thread):
    """Returns the binding `participants` list for one V1 thread."""
    binding = thread.get("binding") or {}
    chat_id, thread_id = binding.get("chatId"), thread.get("id")
    if binding.get("participantIdentityV2"):
        raise PolicyError("participant_identity_v2_requires_manual_mapping")
    groups = [g for g in relay.get("groups") or [] if g.get("chatId") == chat_id]
    if len(groups) != 1 or groups[0].get("threadId") != thread_id:
        raise PolicyError("relay_group_not_found")
    rules = [r for r in relay.get("participantAuthors") or [] if r.get("chatId") == chat_id]
    if not rules:
        return []
    if len(rules) != 1 or rules[0].get("threadId") != thread_id:
        raise PolicyError("relay_participant_rule_invalid")
    if binding.get("allowOtherPeople") is not True or binding.get("mirrorToWhatsApp") is not False:
        return []
    owners = {relay.get("ownChatId")} | set(_ids((relay.get("additionalOwnerAuthors") or {}).get("ids")))
    blocked = set(_ids(binding.get("blockedParticipantIds")))
    security = binding.get("inboundSecurity") if isinstance(binding.get("inboundSecurity"), dict) else {}
    blocked |= set(_ids(security.get("blockedParticipantIds"))) | set(_ids(security.get("blockedParticipants")))
    authorized = set(_ids(binding.get("authorizedContactIds")))
    labels = binding.get("additionalParticipantLabels") or {}
    mapped = []
    for phone in _ids(rules[0].get("ids")):
        if phone.endswith("@c.us") and phone in authorized and phone not in owners and phone not in blocked:
            mapped.append({"ids": [phone], "label": _label(labels, phone), "role": "member"})
    seen = set()
    for entry in mapped:  # Labels must be unique per binding.
        base, n = entry["label"], 2
        while entry["label"].casefold() in seen or entry["label"].casefold() == "owner":
            entry["label"], n = "%s %d" % (base, n), n + 1
        valid_label(entry["label"])
        seen.add(entry["label"].casefold())
    return valid_participants(mapped, [])


def load_thread(db_path, thread_id):
    db = sqlite3.connect("file:%s?mode=ro" % quote(db_path), uri=True)
    try:
        row = db.execute("SELECT data FROM orkestr_threads WHERE id=?", (thread_id,)).fetchone()
    finally:
        db.close()
    if not row:
        raise PolicyError("thread_not_found")
    return dict(json.loads(row[0]), id=thread_id)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--relay-config", required=True)
    parser.add_argument("--v1-threads-db", required=True)
    parser.add_argument("--thread-id", required=True)
    args = parser.parse_args(argv)
    with open(args.relay_config) as stream:
        relay = json.load(stream)
    try:
        value = map_policy(relay, load_thread(args.v1_threads_db, args.thread_id))
    except PolicyError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    print(json.dumps({"participants": value}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
