"""Receipt-derived timing distinguishes silent, uncertain and absorbed input."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from v2.compat.v1_runtime.latency import measure


class LatencyTests(unittest.TestCase):
    def test_only_real_send_receipts_count_and_first_reply_wins(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "synthetic.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE inputs(remote_id TEXT,data TEXT)")
                db.execute("CREATE TABLE exports(seq INTEGER,input_id TEXT,kind TEXT,outcome TEXT,ack TEXT,source_key TEXT)")
                def input(key, **extra):
                    db.execute("INSERT INTO inputs VALUES(?,?)", (key, json.dumps({"queued_at": 100, **extra})))
                def receipt(seq, key, seconds, kind="final", outcome="delivered", source="progress:synthetic"):
                    ack = {"deliveredAt": datetime.fromtimestamp(seconds, timezone.utc).isoformat(),
                           "outcome": "delivered" if outcome == "superseded" else outcome,
                           "connectorMessageIds": ["synthetic-receipt"]}
                    db.execute("INSERT INTO exports VALUES(?,?,?,?,?,?)", (seq, key, kind, outcome, json.dumps(ack), source))
                input("one"); receipt(1, "one", 105, "progress"); receipt(2, "one", 130)
                input("two"); receipt(3, "two", 109)
                receipt(9, "two", 101, "progress", source="stalled:two")
                receipt(10, "two", 102, "progress", source="heartbeat:two")
                input("late-ack"); receipt(7, "late-ack", 103, "progress", outcome="superseded"); receipt(8, "late-ack", 112)
                input("silent", settled={"outcome": "no_reply"})
                input("unknown"); receipt(4, "unknown", 104, outcome="uncertain")
                input("absorbed", absorbed_into="one")
                input("timer", origin="timer"); receipt(5, "timer", 101)
                input("backwards"); receipt(6, "backwards", 99)
            before = path.read_bytes()
            result = measure(path, 100000)
            self.assertEqual((result["sample_n"], result["p50_ms"], result["p95_ms"]), (3, 5000, 9000))
            self.assertEqual(result["silent_no_reply_inputs"], 1)
            self.assertEqual(result["inputs_without_send_receipt"], 2)
            self.assertEqual(result["invalid_timing_receipts"], 1)
            self.assertEqual(result["eligible_inputs"], 6)
            self.assertTrue(result["small_sample"])
            self.assertEqual(measure(path, 101000)["sample_n"], 0)
            self.assertEqual(path.read_bytes(), before, "measurement must not write the ledger")


if __name__ == "__main__":
    unittest.main()
