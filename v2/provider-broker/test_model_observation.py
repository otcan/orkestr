"""Native settings are evidence for one committed override, never authority."""
import copy
import unittest
from test_protocol import opened, ready, request, turn


def settings(**changes):
    value = {"method": "thread/settings/updated", "params": {
        "threadId": "synthetic-native", "threadSettings": {
            "model": "synthetic-luna", "modelProvider": "openai", "effort": "low",
            "cwd": "/synthetic/private", "permissionProfile": "private-metadata"}}}
    value["params"].update(changes)
    return value


def committed():
    channel, _ = opened()
    ready(channel)
    frame = turn()
    frame["params"].update(model="synthetic-luna", effort="low")
    request(channel, frame, "CommitExecution", 6)
    return channel


class ModelObservationTests(unittest.TestCase):
    def test_native_confirmation_before_or_after_ack_is_request_scoped_and_stripped(self):
        for acknowledged in (False, True):
            channel = committed()
            if acknowledged:
                channel.provider({"id": 4, "result": {"turn": {
                    "id": "synthetic-turn", "status": "inProgress"}}})
            result = channel.provider(settings())
            self.assertEqual(result, {"method": "BrokerOutput", "params": {
                "owned_handle": channel.handle, "frame": {"method": "model/observed", "params": {
                    "threadId": "synthetic-native", "requestId": 4, "model": "synthetic-luna"}}}})
            if not acknowledged:
                self.assertIsNone(channel.turn)
                self.assertIsNotNone(channel.pending)
            self.assertFalse(channel.terminal)
            self.assertIsNone(channel.provider(settings()), "bounded to one confirmation")

    def test_uncommitted_default_foreign_invalid_late_and_cancelled_are_ignored(self):
        channel, _ = opened()
        ready(channel)
        self.assertIsNone(channel.provider(settings()))
        request(channel, turn(), "CommitExecution", 6)
        self.assertIsNone(channel.provider(settings()), "no configured override to confirm")
        cases = [settings(threadId="foreign"), settings(threadSettings=None)]
        for key, value in [("model", "old-default"), ("model", "private\nvalue"),
                           ("modelProvider", "foreign"), ("modelProvider", None)]:
            frame = settings()
            frame["params"]["threadSettings"][key] = value
            cases.append(frame)
        for frame in cases:
            channel = committed()
            self.assertIsNone(channel.provider(frame))
            self.assertFalse(channel.model_observed)
            self.assertIsNotNone(channel.provider(settings()))
        for state in ("terminal", "cancelled"):
            channel = committed()
            setattr(channel, state, True)
            self.assertIsNone(channel.provider(settings()))

    def test_normalized_frame_cannot_be_injected_by_native_and_next_request_is_fresh(self):
        channel = committed()
        forged = {"method": "model/observed", "params": {
            "threadId": "synthetic-native", "requestId": 4, "model": "synthetic-luna"}}
        self.assertIsNone(channel.provider(forged))
        self.assertFalse(channel.model_observed)
        self.assertIsNotNone(channel.provider(settings()))
        channel.provider({"id": 4, "result": {"turn": {
            "id": "synthetic-turn", "status": "inProgress"}}})
        channel.provider({"method": "turn/completed", "params": {"threadId": "synthetic-native",
            "turn": {"id": "synthetic-turn", "status": "completed"}}})
        self.assertIsNone(channel.provider(settings()))
        frame = copy.deepcopy(turn())
        frame["id"] = 5
        frame["params"].update(clientUserMessageId="synthetic-next", model="synthetic-next-model")
        request(channel, frame, "CommitExecution", 7)
        self.assertIsNone(channel.provider(settings()), "previous settings cannot confirm next override")
        frame = settings()
        frame["params"]["threadSettings"]["model"] = "synthetic-next-model"
        self.assertEqual(channel.provider(frame)["params"]["frame"]["params"]["requestId"], 5)


if __name__ == "__main__":
    unittest.main()
