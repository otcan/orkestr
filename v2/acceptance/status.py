"""Report specification coverage. This is not an endpoint test runner."""
import json
from pathlib import Path


def main():
    manifest = json.loads(Path(__file__).with_name("cases.json").read_text())
    cases = manifest["cases"]
    ids = [case["id"] for case in cases]
    if manifest["schema_version"] != 1 or not cases or len(ids) != len(set(ids)):
        raise ValueError("invalid acceptance inventory")
    # No pass override: real executable probes must replace this inventory gate.
    for case in cases:
        if case["status"] != "pending" or not case["oracle"] or not case["blocked_on"]:
            raise ValueError("inventory requires pending cases with explicit oracles/blockers")
        print(f"PENDING {case['id']} {case['name']}: {case['blocked_on']}")
    print(f"0 passed; {len(cases)} pending; M1 acceptance NOT satisfied")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
