"""Late old-turn bytes must never be attributed to the next consumed run."""
import unittest
from protocol import Refused
from test_protocol import opened, ready, request, turn


class ContinuationTests(unittest.TestCase):
    def previous(self):
        channel, _ = opened()
        ready(channel)
        request(channel, turn(), "CommitExecution", 6)
        channel.provider({"id":4,"result":{"turn":{"id":"old-turn","status":"inProgress"}}})
        channel.provider({"method":"turn/completed","params":{"threadId":channel.native,
            "turn":{"id":"old-turn","status":"completed"}}})
        return channel

    def test_late_old_notifications_and_reply_refused_after_next_reservation(self):
        for late in (
            {"method":"item/agentMessage/delta","params":{"threadId":"synthetic-native","turnId":"old-turn","delta":"late"}},
            {"method":"turn/completed","params":{"threadId":"synthetic-native","turn":{"id":"old-turn","status":"completed"}}},
            {"id":4,"result":{"turn":{"id":"old-turn","status":"inProgress"}}},
        ):
            channel = self.previous()
            next_turn = turn()
            next_turn["id"] = 5
            next_turn["params"]["clientUserMessageId"] = "message:next"
            request(channel, next_turn, "CommitExecution", 7)
            with self.assertRaises(Refused):
                channel.provider(late)

    def test_duplicate_terminal_and_nonmonotonic_outer_refused(self):
        channel = self.previous()
        with self.assertRaises(Refused):
            channel.provider({"method":"turn/completed","params":{"threadId":channel.native,
                "turn":{"id":"old-turn","status":"completed"}}})
        with self.assertRaises(Refused):
            request(channel, turn(), "CommitExecution", 2)
