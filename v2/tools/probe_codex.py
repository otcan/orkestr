#!/usr/bin/env python3
"""Metadata-only Codex 0.163.0 handshake in a fresh isolated directory.

No thread/start, turn/start, model request, login, or provider profile access.
Only public version and handshake field names are printed, never raw metadata.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="codex")
    parser.add_argument("--scratch-parent", type=Path, required=True)
    args = parser.parse_args()
    binary = shutil.which(args.binary)
    if binary is None:
        raise SystemExit("BLOCKED: Codex executable missing")
    args.scratch_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="metadata-only-", dir=args.scratch_parent) as scratch:
        env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "TMPDIR") if key in os.environ}
        env.update(HOME=scratch, CODEX_HOME=scratch)
        version = subprocess.run([binary, "--version"], env=env, cwd=scratch,
                                 capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if version != "codex-cli 0.163.0":
            raise SystemExit("BLOCKED: installed Codex version differs from 0.163.0")
        request = {"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "orkestr_v2_probe", "title": "Orkestr v2 metadata probe", "version": "0.0.1"},
            "capabilities": {"experimentalApi": False}}}
        process = subprocess.Popen([binary, "app-server", "--listen", "stdio://"],
                                   cwd=scratch, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            # EOF bounds the protocol: the only request sent is initialize.
            output, _ = process.communicate(json.dumps(request) + "\n", timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise SystemExit("BLOCKED: metadata handshake timed out")
        if process.returncode:
            raise SystemExit("BLOCKED: metadata process failed")
        if len(output) > 65536:
            raise SystemExit("BLOCKED: oversized metadata response")
        replies = [json.loads(line) for line in output.splitlines() if line.strip()]
        reply = next((v for v in replies if v.get("id") == 1), None)
        if not reply or not isinstance(reply.get("result"), dict):
            raise SystemExit("BLOCKED: no initialize result")
        print(json.dumps({"version": version, "initialize": "ok", "result_fields": sorted(reply["result"]),
                          "inference": "not_attempted", "auth": "not_checked"}))


if __name__ == "__main__":
    main()
