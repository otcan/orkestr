"""Actual native CLI and health identity; only a disposable disabled server."""
import json
import subprocess
import tomllib
from pathlib import Path
from owned_execution_http import Case, binary


case = Case()
version = tomllib.loads((Path(__file__).resolve().parents[1] / "Cargo.toml").read_text())["workspace"]["package"]["version"]
try:
    absent = case.root / "version-must-not-create-home"
    environment = {"HOME": str(absent), "ORKESTR_V2_HOME": str(absent)}
    output = subprocess.run([str(binary), "--version", "--json"], env=environment,
                            capture_output=True, timeout=3, check=True)
    identity = json.loads(output.stdout)
    assert identity["version"] == version
    assert identity["component"] == "server" and "error" not in identity
    for arguments in [["--version", "--unknown"], ["--unknown"], ["--json"]]:
        refused = subprocess.run([str(binary), *arguments], env=environment,
                                 capture_output=True, timeout=3)
        assert refused.returncode != 0
        assert not absent.exists(), "unknown CLI flags must refuse before opening state"
    for arguments in [["--version"], ["-V"]]:
        text = subprocess.run([str(binary), *arguments], env=environment,
                              capture_output=True, timeout=3, check=True).stdout.decode()
        assert text.strip() == f"orkestr-v2-server {version} source=" + (identity["source_commit"] or "unknown")
        assert not absent.exists()
    case.start()
    code, health, headers = case.request("/api/v2/health", browser=False)
    assert code == 200 and headers["Cache-Control"] == "no-store"
    assert health["status"] == "ok" and health["fixture_mode"] is False
    assert health["build"] == identity
    assert not (case.home / "owned-execution").exists()
finally:
    case.cleanup()
print("native early CLI and health identity match", flush=True)
