#!/usr/bin/env python3
"""Opt-in reviewed owned image probe; never builds/pulls or alters daemon policy."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import socket
import subprocess
import urllib.request


DOCKER = ["docker"]


def run(*args):
    return subprocess.run([*DOCKER, *args], text=True, capture_output=True, check=True, timeout=75).stdout.strip()


def probe(context, reviewed_image_id, reviewed_compose_sha256, acceptance=None):
    context = Path(context).resolve()
    compose = context / "compose.json"
    if hashlib.sha256(compose.read_bytes()).hexdigest() != reviewed_compose_sha256:
        raise RuntimeError("reviewed Compose checksum mismatch")
    config = json.loads(compose.read_text())
    manifest = json.loads((context / "artifact-manifest.json").read_text())
    name = manifest["project"]
    if not re.fullmatch(r"v2-install-[0-9a-f]{12}", name) or config["name"] != name:
        raise RuntimeError("owned isolated project identity required")
    image = name + ":local"
    if config["services"]["server"]["image"] != image:
        raise RuntimeError("owned image identity mismatch")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", reviewed_image_id):
        raise RuntimeError("reviewed local image ID required")
    run("info", "--format", "{{.OSType}}")  # Fail before any mutation when daemon access is denied.
    if run("image", "inspect", image, "--format", "{{.Id}}") != reviewed_image_id:
        raise RuntimeError("reviewed image identity mismatch")
    for resource in ("container", "network", "volume"):
        listing = run(resource, "ls", "--filter", "label=com.docker.compose.project=" + name,
                      *(["--all"] if resource == "container" else []), "--quiet")
        if listing:
            raise RuntimeError("project already has resources; occupants will not be changed")
    if run("volume", "ls", "--filter", "name=^" + name + "-state$", "--quiet"):
        raise RuntimeError("fresh named state volume required; existing volume preserved")
    port = config["services"]["server"]["ports"][0]
    if port["host_ip"] != "127.0.0.1":
        raise RuntimeError("loopback-only publication required")
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", int(port["published"])))
    command = ("compose", "--project-name", name, "--file", str(compose))
    try:
        run(*command, "up", "--no-build", "--pull", "never", "--detach", "--wait", "--wait-timeout", "45")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(manifest["origin"] + "/api/v2/health", timeout=3) as response:
            if response.status != 200:
                raise RuntimeError("container health failed")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(manifest["origin"] + "/", timeout=3) as response:
            if hashlib.sha256(response.read()).hexdigest() != manifest["files"]["ui/index.html"]:
                raise RuntimeError("container served UI differs from packaged artifact")
        result = {"status": "passed", "scope": "owned container health/static HTTP only", "image": reviewed_image_id}
        if acceptance is not None:
            result["candidate_acceptance"] = acceptance(context, name, image, manifest)
        return result
    finally:
        # Only the unique prechecked project and its reviewed owned image are touched.
        # If down fails, retain image and surface cleanup failure for operator inspection.
        run(*command, "down", "--volumes", "--remove-orphans", "--timeout", "10")
        run("image", "rm", image)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sudo", action="store_true", help="use explicitly authorized sudo -n docker path")
    parser.add_argument("--context", required=True)
    parser.add_argument("--reviewed-image-id", required=True)
    parser.add_argument("--reviewed-compose-sha256", required=True)
    args = vars(parser.parse_args())
    if args.pop("sudo"):
        DOCKER = ["sudo", "-n", "docker"]
    print(json.dumps(probe(**args), sort_keys=True))
