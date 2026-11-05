"""Split the workspace test run across CI runners by exact test name.

Every shard builds the same test binaries, lists the same tests and derives the
same assignment, then runs only its own names through the unchanged cargo
command (`-- --exact NAME...`). Cargo stays the runner, so each test binary
keeps its working directory, environment and in-process threading.

    ci_test_shards.py plan --shards N --index K --weights FILE --out PLAN -- cargo test ...
    ci_test_shards.py run --plan PLAN -- cargo test ...
    ci_test_shards.py verify PLAN...

`verify` proves that the shards saw one identical list and that every listed
name was selected by exactly one of them.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

SCHEMA = 1
LISTED = re.compile(r"^(?P<name>.+): (?:test|benchmark)$")


class Refused(RuntimeError):
    pass


def listed(output):
    """Names from `cargo test -- --list --format terse`, sorted and unique.

    The same name in two binaries is one entry: an exact filter reaches every
    binary, so a name must belong to one shard wherever it is defined.
    """
    names = set()
    for line in output.splitlines():
        match = LISTED.match(line)
        if not match:
            continue
        name = match["name"]
        # Cargo hands doc-test arguments to rustdoc as one whitespace-split string.
        if not name or name.startswith("-") or any(part.isspace() for part in name):
            raise Refused(f"test name cannot be passed as an exact filter: {name!r}")
        names.add(name)
    if not names:
        raise Refused("the test listing is empty")
    return sorted(names)


def digest(names):
    return hashlib.sha256("\n".join(names).encode()).hexdigest()


def load_weights(path):
    document = json.loads(pathlib.Path(path).read_text())
    default, tests = document["default_seconds"], document["tests"]
    if not isinstance(default, (int, float)) or default <= 0 or not isinstance(tests, dict):
        raise Refused("weights need a positive default_seconds and a tests object")
    for name, seconds in tests.items():
        if not isinstance(seconds, (int, float)) or seconds <= 0:
            raise Refused(f"weight for {name!r} must be a positive number")
    return float(default), {name: float(seconds) for name, seconds in tests.items()}


def assign(names, shards, default, weights):
    """Longest test first into the least loaded shard.

    Weights only balance the shards. A wrong or missing weight makes a shard
    slower; it cannot drop a test, because every name is placed exactly once.
    """
    if shards < 1:
        raise Refused("at least one shard is required")
    loads, selected = [0.0] * shards, [[] for _ in range(shards)]
    for name in sorted(names, key=lambda item: (-weights.get(item, default), item)):
        target = min(range(shards), key=lambda index: (loads[index], index))
        loads[target] += weights.get(name, default)
        selected[target].append(name)
    return [sorted(group) for group in selected], loads


def make_plan(names, shards, index, default, weights):
    if not 1 <= index <= shards:
        raise Refused("the shard index is outside 1..shards")
    names = sorted(set(names))
    groups, loads = assign(names, shards, default, weights)
    if not groups[index - 1]:
        raise Refused("this shard has no tests; use fewer shards")
    return {
        "schema": SCHEMA,
        "shards": shards,
        "index": index,
        "total": len(names),
        "list_sha256": digest(names),
        "estimated_seconds": round(loads[index - 1], 1),
        "selected": groups[index - 1],
    }


def verify(plans):
    if not plans:
        raise Refused("no shard plans to verify")
    first = plans[0]
    for plan in plans:
        for key in ("schema", "shards", "total", "list_sha256"):
            if plan.get(key) != first.get(key):
                raise Refused(f"shards disagree on {key}")
    if first.get("schema") != SCHEMA:
        raise Refused("unknown plan schema")
    indexes = sorted(plan["index"] for plan in plans)
    if indexes != list(range(1, first["shards"] + 1)):
        raise Refused(f"expected one plan per shard, got indexes {indexes}")
    seen = {}
    for plan in plans:
        for name in plan["selected"]:
            if name in seen:
                raise Refused(f"{name!r} is selected by shards {seen[name]} and {plan['index']}")
            seen[name] = plan["index"]
    names = sorted(seen)
    if len(names) != first["total"] or digest(names) != first["list_sha256"]:
        raise Refused("the shards together do not cover the listed tests exactly once")
    return {"shards": first["shards"], "total": first["total"], "list_sha256": first["list_sha256"]}


def cargo_arguments(arguments):
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    if not arguments or "--" in arguments:
        raise Refused("give the cargo test command after `--`, without test-binary arguments")
    return arguments


def command_plan(options, cargo):
    listing = subprocess.run([*cargo, "--", "--list", "--format", "terse"], check=True,
                             stdout=subprocess.PIPE, text=True).stdout
    default, weights = load_weights(options.weights)
    plan = make_plan(listed(listing), options.shards, options.index, default, weights)
    out = pathlib.Path(options.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, indent=1) + "\n")
    print(f"shard {plan['index']}/{plan['shards']}: {len(plan['selected'])} of {plan['total']} tests, "
          f"about {plan['estimated_seconds']} s, list {plan['list_sha256'][:12]}")


def command_run(options, cargo):
    plan = json.loads(pathlib.Path(options.plan).read_text())
    selected = plan["selected"]
    if plan.get("schema") != SCHEMA or not selected:
        raise Refused("the plan selects no tests")
    print(f"running {len(selected)} tests of shard {plan['index']}/{plan['shards']}", flush=True)
    # Without a filter the binaries would run everything, so the names are never optional.
    os.execvp(cargo[0], [*cargo, "--", "--exact", *selected])


def command_verify(options):
    result = verify([json.loads(pathlib.Path(path).read_text()) for path in options.plans])
    print(json.dumps(result))


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    cargo = []
    if "--" in arguments:
        split = arguments.index("--")
        arguments, cargo = arguments[:split], arguments[split:]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--shards", type=int, required=True)
    plan.add_argument("--index", type=int, required=True)
    plan.add_argument("--weights", required=True)
    plan.add_argument("--out", required=True)
    run = commands.add_parser("run")
    run.add_argument("--plan", required=True)
    check = commands.add_parser("verify")
    check.add_argument("plans", nargs="+")
    options = parser.parse_args(arguments)
    try:
        if options.command == "verify":
            command_verify(options)
        elif options.command == "plan":
            command_plan(options, cargo_arguments(cargo))
        else:
            command_run(options, cargo_arguments(cargo))
    except Refused as error:
        raise SystemExit(f"ci_test_shards: {error}") from error


if __name__ == "__main__":
    main()
