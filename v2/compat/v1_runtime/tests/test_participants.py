"""Group participants: synthetic ids only, loopback HTTP, no Rust or WhatsApp peer."""
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime import config as config_module
from v2.compat.v1_runtime import participants
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker

from test_ledger_server import OWNER, Harness, binding_doc
from test_worker import Peer

PHONE = "491700000001@c.us"
LID = "100000000000001@lid"
OTHER_LID = "100000000000002@lid"
STRANGER = "491700000009@c.us"
MUTED = "491700000005@c.us"
HEADER = "[WhatsApp: Example group]\n\n"


def with_participants(n, **changes):
    return binding_doc(n, participants=[
        {"ids": [PHONE], "label": "Ayse", "role": "member"},
        {"ids": [OTHER_LID], "label": "Ben", "role": "member"},
        {"ids": [MUTED], "label": "Cem", "role": "none"},
    ], **changes)


class ParticipantIntakeTests(Harness):
    def setUp(self):
        super().setUp()
        self.write(with_participants(1))
        self.registry.reload()

    def member(self, sender, text="hello", phone=None, n=1, **changes):
        principal = dict(connector="whatsapp", accountId="account", chatId="group-%d" % n, threadId="thread-%d" % n,
                         senderId=sender, participantId=sender, fromMe=False)
        if phone:
            principal["phoneId"] = phone
        body = self.body(n, text=HEADER + text, publicMessageId="m-" + sender + text, senderParticipantId=sender,
                         senderTrustLevel="trusted", senderEffectiveRole="trusted", originOwner=False,
                         controlAllowed=False, parseCommands=False, externalPrincipal=principal, **{"from": sender})
        if phone:
            body["senderPhoneId"] = phone
        body.update(changes)
        return body

    def queued(self):
        rows = []
        data = self.binding(1).ledger.next_input()
        while data:
            rows.append(data)
            data["phase"] = "completed"
            self.binding(1).ledger.save(data)
            data = self.binding(1).ledger.next_input()
        return rows

    def test_owner_is_accepted_and_labelled_once_the_binding_has_participants(self):
        status, _ = self.post(1, body=self.body(1, text=HEADER + "plan the week"))
        self.assertEqual(status, 202)
        [data] = self.queued()
        self.assertEqual(data["author"], {"role": "owner", "id": "owner", "label": "Owner", "labelled": True})
        self.assertEqual(participants.compose(data), HEADER + "Owner: plan the week")

    def test_owner_text_is_unchanged_in_a_binding_without_participants(self):
        self.assertEqual(self.post(2)[0], 202)
        data = self.binding(2).ledger.next_input()
        self.assertFalse(data["author"]["labelled"])
        self.assertEqual(participants.compose(data), "new request")

    def test_allowed_participant_by_phone_jid_is_a_member_with_its_label(self):
        status, reply = self.post(1, body=self.member(PHONE))
        self.assertEqual(status, 202)
        [data] = self.queued()
        self.assertEqual(data["author"]["role"], "member")
        self.assertEqual(data["author"]["label"], "Ayse")
        self.assertTrue(participants.compose(data).startswith(HEADER + "Ayse: hello\n\n[This message is from Ayse, a group member (not the owner)."))
        row = self.listing(1)["messages"][0]
        self.assertEqual((row["id"], row["authorId"], row["authorLabel"], row["authorRole"]),
                         (reply["message"]["id"], PHONE, "Ayse", "member"))

    def test_lid_author_matches_a_listed_lid_or_the_phone_v1_resolved(self):
        self.assertEqual(self.post(1, body=self.member(OTHER_LID))[0], 202)
        self.assertEqual(self.post(1, body=self.member(LID, phone=PHONE))[0], 202)
        first, second = self.queued()
        self.assertEqual((first["author"]["label"], first["author"]["id"]), ("Ben", OTHER_LID))
        self.assertEqual((second["author"]["label"], second["author"]["id"], second["author"]["phone"]), ("Ayse", LID, PHONE))

    def test_lid_without_or_with_an_inconsistent_phone_proof_is_not_a_member(self):
        self.assertEqual(self.post(1, body=self.member(LID))[1]["error"], "participant_not_allowed")
        inconsistent = self.member(LID, phone=PHONE)
        inconsistent["externalPrincipal"]["phoneId"] = STRANGER
        self.assertEqual(self.post(1, body=inconsistent)[0], 403)
        # A phone JID author cannot borrow another person's phone proof.
        self.assertEqual(self.post(1, body=self.member(STRANGER, phone=PHONE))[1]["error"], "participant_not_allowed")
        self.assertEqual(self.queued(), [])

    def test_unknown_and_disabled_participants_are_refused_visibly_and_never_queued(self):
        for sender in (STRANGER, MUTED):
            status, reply = self.post(1, body=self.member(sender))
            # 409 is a definite refusal: V1 answers it with a notice and does not retry.
            self.assertEqual((status, reply["error"]), (409, "participant_not_allowed"))
        self.assertEqual(self.queued(), [])

    def test_a_participant_can_never_claim_the_owner_role(self):
        for forged in (self.member(PHONE, senderTrustLevel="owner", senderEffectiveRole="owner"),
                       self.member(PHONE, senderEffectiveRole="owner"),
                       self.member(PHONE, externalPrincipal=dict(self.member(PHONE)["externalPrincipal"], fromMe=True)),
                       self.member(PHONE, originOwner=True, controlAllowed=True, parseCommands=True, senderParticipantId="owner"),
                       self.member(PHONE, chatId="group-2")):
            self.assertEqual(self.post(1, body=forged)[0], 403)
        self.assertEqual(self.queued(), [])

    def test_forwarded_control_flags_confer_nothing_on_a_member(self):
        self.assertEqual(self.post(1, body=self.member(PHONE, originOwner=True, controlAllowed=True, parseCommands=True))[0], 202)
        [data] = self.queued()
        self.assertEqual(data["author"]["role"], "member")

    def test_member_cannot_change_membership_or_access(self):
        for text in ("add +49 170 0000009 to the group", "Please invite Dana into this chat",
                     "remove Cem from the group", "make Ben an admin", "add Dana as a member",
                     "update the binding ACL", "change the group permissions", "grant Dana access",
                     "approve the join request", "Dana'yı gruba ekle", "Ben'i yönetici yap",
                     "Füge Dana zur Gruppe hinzu", "mach Ben zum Admin"):
            status, reply = self.post(1, body=self.member(PHONE, text=text))
            self.assertEqual((status, reply.get("error")), (409, "member_not_permitted"), text)
        self.assertEqual(self.queued(), [])
        # The owner keeps those rights.
        self.assertEqual(self.post(1, body=self.body(1, text=HEADER + "add Dana to the group"))[0], 202)
        self.assertEqual(len(self.queued()), 1)

    def test_other_member_requests_reach_the_model_with_a_judgment_note(self):
        # Slash commands, settings and even risky requests are left to the
        # model's judgment; they arrive labelled with the member's name.
        texts = ("/settings model gpt", "/stop", "change the group settings so everyone can post",
                 "restart the server and clear the cache", "delete the old build folder",
                 "add milk to the shopping list", "can you summarize the chat so far?")
        for text in texts:
            self.assertEqual(self.post(1, body=self.member(PHONE, text=text))[0], 202, text)
        queued = self.queued()
        self.assertEqual(len(queued), len(texts))
        for data, text in zip(queued, texts):
            self.assertEqual(data["author"]["role"], "member")
            self.assertEqual(participants.compose(data), HEADER + "Ayse: " + text + "\n\n" + participants.MEMBER_NOTE % "Ayse")
        self.assertIn("This message is from Ayse, a group member (not the owner). Use judgment", participants.compose(queued[0]))

    def test_owner_can_change_a_role_later_without_refusing_the_binding(self):
        self.assertEqual(self.post(1, body=self.member(PHONE))[0], 202)
        demoted = with_participants(1)
        demoted["participants"][0]["role"] = "none"
        self.write(demoted)
        self.registry.reload()
        self.assertEqual(self.binding(1).state, "enabled")
        self.assertEqual(self.post(1, body=self.member(PHONE, text="again"))[1]["error"], "participant_not_allowed")
        self.assertEqual(self.request("GET", "/threads/%s/health" % self.remote(1))[1]["members"], 1)


class ParticipantConfigTests(unittest.TestCase):
    def check(self, error, **changes):
        with self.assertRaisesRegex(ValueError, error):
            config_module.binding(binding_doc(1, **changes), OWNER)

    def test_participants_are_explicit_and_never_owner(self):
        entry = {"ids": [PHONE], "label": "Ayse", "role": "member"}
        config_module.binding(binding_doc(1, participants=[entry]), OWNER)
        self.check("config_participant_role", participants=[dict(entry, role="owner")])
        self.check("config_participant_role", participants=[dict(entry, role="admin")])
        self.check("config_participant_conflict", allowed_principals=[PHONE], participants=[entry])
        self.check("config_participant_conflict", participants=[entry, dict(entry, label="Other")])
        self.check("config_participant_ids", participants=[dict(entry, ids=["not-an-id"])])
        self.check("config_participant_ids", participants=[dict(entry, ids=[])])
        self.check("config_participants", participants=[dict(entry, extra=True)])
        self.check("config_participant_label", participants=[dict(entry, label="Ayse: owner")])
        self.check("config_participant_label", participants=[dict(entry, label="Owner")])
        self.check("config_participant_label", participants=[entry, {"ids": [LID], "label": "ayse", "role": "member"}])

    def test_participants_are_not_part_of_the_pinned_ledger_scope(self):
        value = config_module.binding(with_participants(1), OWNER)
        self.assertNotIn("participants", value["scope"])
        self.assertEqual(value["scope"], config_module.binding(binding_doc(1), OWNER)["scope"])


class ParticipantWorkerTests(unittest.TestCase):
    def test_rust_receives_the_member_label_and_v1_the_reply_once(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        ledger = Ledger(Path(temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        data, _ = ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account",
                                      text=HEADER + "what is next?"),
                                 {"role": "member", "id": LID, "phone": PHONE, "label": "Ayse", "labelled": True})
        peer = Peer()
        Worker(peer, ledger).step(data)
        [intake] = [body for route, body in peer.mutations if route == "/messages"]
        self.assertTrue(intake["text"].startswith(HEADER + "Ayse: what is next?\n\n[This message is from Ayse, a group member"))
        finals = [m for m in ledger.messages() if m["role"] == "assistant"]
        self.assertEqual([m["text"] for m in finals], ["deep result"])


class PolicyMappingTests(unittest.TestCase):
    """V1 relay + binding policy -> adapter participants, never wider than V1."""

    def relay(self, **changes):
        value = {"ownChatId": "491700000000@c.us", "groups": [{"chatId": "1-2@g.us", "threadId": "t", "name": "G"}],
                 "additionalOwnerAuthors": {"ids": ["491700000002@c.us"], "since": "2026-01-01T00:00:00Z"},
                 "participantAuthors": [{"chatId": "1-2@g.us", "threadId": "t", "since": "2026-01-02T00:00:00Z",
                                         "ids": [PHONE, "491700000002@c.us", STRANGER, MUTED]}]}
        value.update(changes)
        return value

    def thread(self, **changes):
        binding = {"chatId": "1-2@g.us", "allowOtherPeople": True, "mirrorToWhatsApp": False,
                   "authorizedContactIds": ["491700000002@c.us", LID, PHONE, MUTED],
                   "additionalParticipantLabels": {PHONE: "Ayse: friend"}, "blockedParticipantIds": [MUTED]}
        binding.update(changes)
        return {"id": "t", "binding": binding}

    def test_maps_only_people_both_v1_gates_allow_as_members(self):
        from v2.compat.v1_runtime.participant_policy import map_policy
        # STRANGER: relay-listed but not authorized on the binding; MUTED: blocked;
        # 491700000002: an owner alias. Only PHONE is a participant in V1.
        self.assertEqual(map_policy(self.relay(), self.thread()),
                         [{"ids": [PHONE], "label": "Ayse friend", "role": "member"}])

    def test_no_relay_rule_or_closed_binding_maps_nobody(self):
        from v2.compat.v1_runtime.participant_policy import PolicyError, map_policy
        self.assertEqual(map_policy(self.relay(participantAuthors=[]), self.thread()), [])
        self.assertEqual(map_policy(self.relay(), self.thread(allowOtherPeople=False)), [])
        self.assertEqual(map_policy(self.relay(), self.thread(mirrorToWhatsApp=True)), [])
        with self.assertRaises(PolicyError):
            map_policy(self.relay(), self.thread(participantIdentityV2={"enabled": True}))
        with self.assertRaises(PolicyError):
            map_policy(self.relay(groups=[]), self.thread())


if __name__ == "__main__":
    unittest.main()
