"""Worker role transport metadata is not Core parent/task admission authority."""
import unittest
from protocol import Channel, PROTOCOL, Refused
from test_protocol import IDENTITY, ready, request, turn


def open_role(role, session):
    channel = Channel("/synthetic/workspace")
    identity = dict(IDENTITY, role=role, session_id=session)
    _, response = channel.client({"id":1,"method":"OpenOwnedSession","params":{
        "protocol":PROTOCOL,"identity":identity}})
    return channel, response["result"]


class WorkerRoleTests(unittest.TestCase):
    def test_same_owner_parent_and_worker_keep_distinct_sessions_and_handles(self):
        parent, parent_result = open_role("deep", "parent-session")
        worker, worker_result = open_role("worker", "worker-session")
        self.assertEqual(parent_result["identity"]["owner_id"], worker_result["identity"]["owner_id"])
        self.assertNotEqual(parent_result["identity"]["session_id"], worker_result["identity"]["session_id"])
        self.assertEqual(worker_result["identity"]["role"], "worker")
        self.assertNotEqual(parent.handle, worker.handle)
        self.assertTrue(worker_result["metadata_only"])
        ready(parent, "parent-native")
        ready(worker, "worker-native")
        with self.assertRaises(Refused):
            request(worker, turn("parent-native"), "CommitExecution", 6)
        with self.assertRaises(Refused):
            parent.client({"id":6,"method":"BrokerMetadata","params":{
                "owned_handle":worker.handle,"frame":{"method":"initialized"}}})
        outgoing, _ = request(worker, turn("worker-native"), "CommitExecution", 7)
        self.assertEqual(outgoing["params"]["threadId"], "worker-native")

    def test_worker_role_alone_cannot_skip_setup_or_admit_parent_claims(self):
        worker, _ = open_role("worker", "worker-session")
        with self.assertRaises(Refused):
            request(worker, turn(), "CommitExecution")
        identity = dict(IDENTITY, role="worker", parent_run="synthetic-parent")
        with self.assertRaises(Refused):
            Channel("/synthetic").client({"id":1,"method":"OpenOwnedSession","params":{
                "protocol":PROTOCOL,"identity":identity}})
        for role in ("Worker", "admin", "tool", "", "worker:deep"):
            with self.assertRaises(Refused):
                open_role(role, "synthetic-session")
