"""Independent immutable clock-boundary oracle against a path-loaded ledger."""
import json
import pathlib
import sys
import tempfile
import unittest
import uuid

from codex_service import contract
from codex_service.ledger import Ledger


def identifier():
    return str(uuid.uuid4())


class Clock:
    def __init__(self):
        self.boot = identifier()
        self.origin = 1_800_000_000_000_000_000
        self.wall = self.origin
        self.mono = 10_000_000_000
        self.samples = []

    def sample(self):
        if self.samples:
            self.wall, self.mono = self.samples.pop(0)
        return self.boot, self.wall, self.mono


class ClockBoundaries(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='synthetic-clock-')
        self.addCleanup(temp.cleanup)
        self.clock = Clock()
        self.owner, self.conversation = identifier(), identifier()
        self.ledger = Ledger(str(pathlib.Path(temp.name) / 'ledger.sqlite3'),
                             self.owner, self.conversation, clock=self.clock)
        self.addCleanup(self.ledger.close)
        opened = self.clock.origin // 1_000_000
        self.request = {
            'version': 1, 'operation': 'admit', 'request_id': identifier(),
            'owner_id': self.owner, 'conversation_id': self.conversation,
            'window_id': identifier(), 'generation': 1, 'expected_generation': 0,
            'input_message_id': identifier(), 'input_event_id': identifier(),
            'input_request_key': 'synthetic-input', 'predecessor_window_id': None,
            'opened_at_ms': opened, 'work_deadline_ms': opened + 870_000,
            'expires_at_ms': opened + 900_000,
        }
        self.ledger.admit(contract.decode(json.dumps(self.request).encode()))

    def test_active_join_checks_soft_cutoff_at_transaction_clock(self):
        # The request arrives at869s; acquiring the transaction spans the cutoff.
        self.clock.samples = [(self.clock.origin + 869_000_000_000, 879_000_000_000),
                              (self.clock.origin + 871_000_000_000, 881_000_000_000)]
        followup = {**self.request, 'request_id': identifier(), 'input_message_id': identifier(),
                    'input_event_id': identifier(), 'input_request_key': 'synthetic-next',
                    'expected_generation': 1}
        with self.assertRaises(contract.Refused):
            self.ledger.admit(contract.decode(json.dumps(followup).encode()))

    def test_clock_failure_is_sticky_after_forward_jump_and_correction(self):
        # Monotonic time never goes backwards. Wall time jumps past expiry only
        # between tick and reservation; subsequent correction cannot erase loss.
        self.clock.samples = [(self.clock.origin + 5_000_000_000, 15_000_000_000),
                              (self.clock.origin + 901_000_000_000, 15_000_000_000)]
        with self.assertRaisesRegex(contract.Refused, 'window_clock'):
            self.ledger.reserve(self.request['window_id'], 1, identifier(), 'attempt', 1)
        self.clock.samples = [(self.clock.origin + 6_000_000_000, 16_000_000_000)]
        with self.assertRaises(contract.Refused):
            self.ledger.reserve(self.request['window_id'], 1, identifier(), 'attempt', 1)
        self.assertEqual(self.ledger.status()['attempts'], 0)
        self.assertEqual(self.ledger.status()['state'], 'reconciliation')


if __name__ == '__main__':
    unittest.main()
