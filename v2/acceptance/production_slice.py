"""Independent ordinary-server gate. Fixture results never satisfy this gate."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import unittest

from intake_blackbox import IntakeProbes


PENDING = {
    "ordinary_dispatch": "Public authorized ordinary Store bootstrap/admit/dispatch unavailable",
    "provider_protocol": "Exact real adapter and protocol-owned child handoff unavailable",
    "lease_authority": "Ordinary renewal/current-generation/refusal implementation unavailable",
    "unknown_outcome": "Ordinary consume-before-I/O and process-reopen reconciliation unavailable",
    "cancellation": "Ordinary cancellation/control/Stopped route unavailable",
    "browser_session": "Browser cookie/CSRF interaction requires independent executable coverage",
    "release_parity": "Full used-workflow, performance, migration and rollback gates remain separate",
}


class OrdinaryServerProbes(IntakeProbes):
    def test_machine_namespace_and_origin_refusals(self):
        before = self.counts()
        token = self.token
        path = f"/conversations/{self.conversation}/messages"
        for authorization in ("browser:" + token, token[:-1], token + "0", "z" * 64):
            with self.subTest(kind="malformed-machine-namespace"):
                self.token = authorization
                self.assertEqual(self.call("POST", path, {
                    "client_message_id": "refused", "text": "Synthetic refusal"
                })[0], 401)
                self.assertEqual(self.counts(), before)
        self.token = token
        for origin in (f"http://127.0.0.1:{self.port}", "null", "https://foreign.example"):
            with self.subTest(origin=origin):
                self.assertEqual(self.call("POST", path, {
                    "client_message_id": "origin-refused", "text": "Synthetic refusal"
                }, {"Origin": origin})[0], 403)
                self.assertEqual(self.counts(), before)
        self.assertEqual(self.admit()[0], 202)


# Explicit selection prevents inherited fixture/isolation cases being silently
# counted as production workflow coverage. The restart case owns and SIGKILLs
# only the process spawned by this harness after receipt; it proves intake only.
CASES = (
    "test_receipt_concurrency_conflict_and_restart",
    "test_sse_header_cursor_precedes_query_cursor",
    "test_machine_namespace_and_origin_refusals",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--source-head", required=True,
                        help="Exact build source SHA; caller must retain build provenance")
    parser.add_argument("--port", type=int, default=47140, choices=range(47140, 47150))
    args = parser.parse_args()
    if not args.binary.is_absolute() or not args.home.is_absolute():
        parser.error("binary and owned isolated home must be absolute")
    if len(args.source_head) != 40 or any(c not in "0123456789abcdef" for c in args.source_head):
        parser.error("source-head must be a full lowercase hexadecimal commit")
    args.home.mkdir(parents=True, exist_ok=True)
    OrdinaryServerProbes.binary = str(args.binary)
    OrdinaryServerProbes.parent = args.home
    OrdinaryServerProbes.port = args.port
    binary_hash = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    suite = unittest.TestSuite(OrdinaryServerProbes(name) for name in CASES)
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
    print(json.dumps({
        "source_head_reported": args.source_head,
        "binary_sha256": binary_hash,
        "build_provenance": "Caller-supplied source pin; hash alone does not prove source equivalence",
        "ordinary_server": {"executed": result.testsRun,
                            "passed": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
                            "failed": len(result.failures), "errors": len(result.errors)},
        "pending": PENDING,
        "production_slice_accepted": False,
    }, indent=2))
    # Executable partial coverage must never report a successful full slice.
    return 1


if __name__ == "__main__":
    sys.exit(main())
