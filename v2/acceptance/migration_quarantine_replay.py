#!/usr/bin/env python3
"""Independent inert-planner regressions against exact committed source.

Run with --checkout PATH --revision FULL_COMMIT. Sources are read with git show
and loaded in a temporary directory; the checkout and its dirty files are never
changed or executed. Synthetic interchange records only; no database, provider,
credential, process launcher, or product importer is used.

Baseline e07c1ca5 has two known failures: persisted quarantine is not included in
new reference closure, and implicit message/thread edges do not propagate it.
The expected safety behavior below must remain unchanged when evaluating fixes.
This is not full migration or runtime acceptance.
"""

import argparse
from collections import Counter
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


SOURCE_PATHS = ("v2/migration/snapshot.py", "v2/migration/planner.py")
PLANNER = None
SNAPSHOT = None


def row(kind, key, *, references=(), payload=None):
    return {"kind": kind, "key": key, "owner": "synthetic-owner",
            "scope": "synthetic-project", "source_state": None,
            "references": list(references), "payload": payload or {}}


def reference(kind, key):
    return {"relation": "parent", "kind": kind, "key": key}


def document(records, instance="synthetic-instance"):
    value = {
        "version": 1, "source_instance": instance,
        "snapshot_id": "synthetic-quarantine-replay", "origin": "legacy",
        "source_version": "synthetic-only", "schema_versions": {"synthetic": "1"},
        "consistency": {"method": "synthetic", "watermark": "synthetic-1",
                        "segments": {"synthetic": "synthetic-1"},
                        "export_receipt": "synthetic-not-a-production-export"},
        "records": copy.deepcopy(records), "artifacts": [],
        "counts": dict(Counter(record["kind"] for record in records)),
    }
    value["digest"] = SNAPSHOT.sha(value)
    # Exercise the actual interchange validator as well as the planner. There
    # are no referenced artifacts, so the synthetic root is never read.
    with tempfile.TemporaryDirectory(prefix="v2-quarantine-input-") as root:
        return SNAPSHOT.validate_document(value, Path(root))


def initial_records():
    return [row("thread", ["synthetic-thread"]),
            row("message", ["synthetic-thread", "parent"], payload={"position": 1, "text": "Original"}),
            row("thread", ["unrelated-thread"]),
            row("message", ["unrelated-thread", "unrelated"], payload={"position": 1})]


def ledger_entry(ledger, snapshot, record):
    return ledger["entries"][PLANNER.map_key(snapshot["source_instance"], record)]


class QuarantineReplayTests(unittest.TestCase):
    def conflicted_parent(self):
        original = document(initial_records())
        first, _ = PLANNER.reconcile(original)
        changed = copy.deepcopy(original["records"])
        changed[1]["payload"]["text"] = "Conflicting synthetic payload"
        second, _ = PLANNER.reconcile(document(changed), first)
        self.assertEqual(ledger_entry(second, original, original["records"][1])["disposition"], "QUARANTINED")
        return original, first, second

    def test_prior_conflict_quarantines_new_children_and_descendants(self):
        original, first, second = self.conflicted_parent()
        records = copy.deepcopy(original["records"])
        records += [
            row("message", ["synthetic-thread", "child"],
                references=[reference("message", ["synthetic-thread", "parent"])], payload={"position": 2}),
            row("message", ["synthetic-thread", "grandchild"],
                references=[reference("message", ["synthetic-thread", "child"])], payload={"position": 3}),
        ]
        incoming = document(records)
        before = copy.deepcopy(second)
        third, _ = PLANNER.reconcile(incoming, second)
        self.assertEqual(second, before, "reconcile mutated its prior ledger")
        self.assertEqual(ledger_entry(third, original, records[1])["digest"],
                         ledger_entry(first, original, records[1])["digest"], "original fingerprint was replaced")
        for dependent in records[-2:]:
            with self.subTest(dependent=dependent["key"]):
                self.assertEqual(ledger_entry(third, incoming, dependent)["disposition"], "QUARANTINED",
                                 "new lineage depends on an already quarantined identity")
        self.assertFalse(third["dispatch_allowed"])

    def test_implicit_thread_ownership_propagates_quarantine(self):
        records = [
            row("thread", ["thread-a"], references=[reference("thread", ["thread-b"])]),
            row("thread", ["thread-b"], references=[reference("thread", ["thread-a"])]),
            row("message", ["thread-a", "message-a"], payload={"position": 1}),
            row("message", ["thread-b", "message-b"], payload={"position": 1}),
        ]
        incoming = document(records)
        ledger, _ = PLANNER.reconcile(incoming)
        for record in records:
            with self.subTest(kind=record["kind"], key=record["key"]):
                self.assertEqual(ledger_entry(ledger, incoming, record)["disposition"], "QUARANTINED",
                                 "a message implicitly belongs to its quarantined thread")

    def test_unrelated_history_remains_usable_after_conflict(self):
        original, _, second = self.conflicted_parent()
        incoming = document(original["records"])
        ledger, _ = PLANNER.reconcile(incoming, second)
        for record in original["records"][-2:]:
            self.assertEqual(ledger_entry(ledger, incoming, record)["disposition"], "HISTORY_ONLY",
                             "blanket quarantine is not a valid dependency fix")

    def test_same_identifiers_in_another_instance_do_not_inherit_quarantine(self):
        original, _, second = self.conflicted_parent()
        incoming = document(original["records"], instance="other-synthetic-instance")
        ledger, _ = PLANNER.reconcile(incoming, second)
        for record in incoming["records"]:
            self.assertEqual(ledger_entry(ledger, incoming, record)["disposition"], "HISTORY_ONLY")
        self.assertEqual(ledger_entry(ledger, original, original["records"][1])["disposition"], "QUARANTINED")

    def test_reopened_ledger_retains_quarantine_and_repeat_is_stable(self):
        original, _, second = self.conflicted_parent()
        reopened = json.loads(json.dumps(second))
        third, _ = PLANNER.reconcile(original, reopened)
        fourth, _ = PLANNER.reconcile(original, third)
        self.assertEqual(third, fourth)
        self.assertEqual(ledger_entry(fourth, original, original["records"][1])["disposition"], "QUARANTINED")
        self.assertFalse(fourth["dispatch_allowed"])


def git(checkout, *args):
    result = subprocess.run(["git", "-C", str(checkout), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, check=False)
    if result.returncode:
        raise ValueError("cannot read requested committed source")
    return result.stdout


def module_from(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        parser.error("--revision must be a full lowercase commit hash")
    try:
        actual = git(args.checkout, "rev-parse", "--verify", args.revision + "^{commit}").decode().strip()
        if actual != args.revision:
            raise ValueError("revision did not resolve exactly")
        with tempfile.TemporaryDirectory(prefix="v2-quarantine-code-") as root:
            hashes = {}
            for source in SOURCE_PATHS:
                content = git(args.checkout, "show", args.revision + ":" + source)
                (Path(root) / Path(source).name).write_bytes(content)
                hashes[source] = hashlib.sha256(content).hexdigest()
            global PLANNER, SNAPSHOT
            SNAPSHOT = module_from(Path(root) / "snapshot.py", "snapshot")
            PLANNER = module_from(Path(root) / "planner.py", "planner")
            print(json.dumps({"revision": actual, "source_sha256": hashes,
                              "scope": "synthetic inert-planner acceptance only"}), flush=True)
            suite = unittest.defaultTestLoader.loadTestsFromTestCase(QuarantineReplayTests)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            return 0 if result.wasSuccessful() else 1
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print("Cannot load committed migration source; no checkout was changed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    raise SystemExit(main())
