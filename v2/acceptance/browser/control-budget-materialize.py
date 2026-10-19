#!/usr/bin/python3
"""Materialize source-pinned reviewed browser helpers into a fresh private run dir."""
import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile

PAIR = "1d9674b29ed547f4a0cf5530a261aba9450263a1"
HELPERS = "8a3f91a876a40de00e1b42c879915e9734e58027"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--pair", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pair = json.loads(args.pair.read_text())
    assert pair["source_commit"] == PAIR
    root = args.output.resolve()
    root.mkdir(mode=0o700)  # Never overwrite a receipt or prior execution.
    harness, source = root / "harness", root / "source"
    harness.mkdir(mode=0o700)
    source.mkdir(mode=0o700)
    repository = args.repository.resolve(strict=True)

    def git(*arguments):
        return subprocess.check_output(["git", "--no-replace-objects", "-C", str(repository), *arguments])

    archive = git("archive", PAIR, "v2/tests", "v2/provider-broker")
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        for entry in entries:
            assert not Path(entry.name).is_absolute() and ".." not in Path(entry.name).parts
            target = source / entry.name
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                assert entry.isfile(), "regular_fixture_sources_only"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(entries.extractfile(entry).read())
    for name in ["worker-fixture.mjs", "worker-support.mjs", "support.mjs"]:
        (harness / name).write_bytes(git("show", f"{HELPERS}:v2/acceptance/browser/{name}"))
    here = Path(__file__).resolve().parent
    for destination, authored in {
        "worker-runner.mjs": "control-budget-runner.mjs",
        "worker-fixture.py": "control-budget-fixture.py",
        "worker-artifacts.mjs": "control-budget-artifacts.mjs",
        "control-budget-scenarios.mjs": "control-budget-scenarios.mjs",
    }.items():
        (harness / destination).write_bytes((here / authored).read_bytes())
    value = {"schema_version": 1,
             "server": {"path": pair["server"]["path"], "source_sha": PAIR, "features": "default",
                        "sha256": pair["server"]["sha256"]},
             "ui": {"path": pair["web"]["path"], "source_sha": PAIR,
                    "files": {name: item["sha256"] for name, item in pair["web"]["files"].items()}},
             "fixture": {"path": str(source), "repository": str(repository), "source_sha": PAIR}}
    (root / "provenance.json").write_text(json.dumps(value, indent=2) + "\n")
    print(json.dumps({"harness": str(harness), "provenance": str(root / "provenance.json")}))


if __name__ == "__main__":
    main()
