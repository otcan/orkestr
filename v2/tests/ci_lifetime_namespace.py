"""Permit only the fixed lifetime launcher on an evidenced hosted Ubuntu runner.

No production configuration, global sysctl, root test execution or test skipping.
Ubuntu documents per-executable userns attachment profiles here:
https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PROFILE_NAME = "orkestr-ci-lifetime-bwrap"
PROFILE = """abi <abi/4.0>,
include <tunables/global>
profile orkestr-ci-lifetime-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
"""
COMMAND = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--die-with-parent",
           "--bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/python3", "-c",
           "print('orkestr-lifetime-namespace-ready', flush=True)"]
ENVIRONMENT = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


class Refused(RuntimeError):
    pass


def require(value, reason):
    if not value:
        raise Refused(reason)


def command(args, *, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True,
                            timeout=10, env=ENVIRONMENT)
    require(result.returncode == 0, "hosted_runner_diagnostic_or_profile_command_failed")
    require(len(result.stdout) + len(result.stderr) <= 1024 * 1024, "diagnostic_output_limit")
    return result.stdout


def probe():
    child = subprocess.Popen(COMMAND, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=ENVIRONMENT, start_new_session=True)
    try:
        output, error = child.communicate(timeout=10)
    except BaseException:
        child.kill()
        child.communicate(timeout=3)
        raise
    return {"pid": child.pid, "code": child.returncode,
            "output": output[:8192], "error": error[:8192]}


def ready(result):
    return result["code"] == 0 and result["output"].strip() == "orkestr-lifetime-namespace-ready"


def matching_denials(before, after, pid):
    previous = set(before.splitlines())
    return [line for line in after.splitlines() if line not in previous
            and 'apparmor="DENIED"' in line and 'profile="unprivileged_userns"' in line
            and 'comm="bwrap"' in line and re.search(r"\bpid=" + str(pid) + r"\b", line)]


def run():
    require(os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("RUNNER_OS") == "Linux" and os.geteuid() != 0,
            "only_unprivileged_github_hosted_runner_supported")
    require(not Path("/.dockerenv").exists() and not Path("/run/systemd/container").exists(),
            "container_policy_is_not_a_host_profile_problem")
    require('ID=ubuntu' in Path("/etc/os-release").read_text().splitlines(), "ubuntu_runner_required")
    executable = Path("/usr/bin/bwrap")
    info = executable.stat()
    require(executable.resolve() == executable and info.st_uid == 0 and not info.st_mode & 0o022,
            "protected_fixed_bwrap_required")
    before = command(["sudo", "-n", "dmesg", "--raw"])
    first = probe()
    if ready(first):
        return {"status": "ready", "profile_applied": False, "test_uid": os.geteuid()}

    # Capture the actual denial before considering a policy change. A different
    # profile, process, missing binary, seccomp denial or disabled userns remains red.
    after = command(["sudo", "-n", "dmesg", "--raw"])
    denials = matching_denials(before, after, first["pid"])
    restriction = Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").read_text().strip()
    label = Path("/proc/self/attr/current").read_text().strip()
    enabled = Path("/sys/module/apparmor/parameters/enabled").read_text().strip()
    profiles = command(["sudo", "-n", "cat", "/sys/kernel/security/apparmor/profiles"])
    print(json.dumps({"status": "prerequisite_denied", "probe_pid": first["pid"],
        "exit": first["code"], "stderr": first["error"], "runner_label": label,
        "restriction": restriction, "apparmor_enabled": enabled,
        "matching_kernel_denials": [line[:1024] for line in denials]}, sort_keys=True), flush=True)
    require(enabled == "Y" and restriction == "1" and label == "unconfined" and denials,
            "exact_apparmor_default_userns_denial_not_proven")
    require(not any(PROFILE_NAME in line or "/usr/bin/bwrap" in line for line in profiles.splitlines()),
            "existing_lifetime_profile_must_not_be_replaced")

    # Add a temporary, uniquely named attachment. Never replace an existing
    # profile and never disable the host-wide unprivileged-userns restriction.
    command(["sudo", "-n", "apparmor_parser", "--add", "--skip-cache"], data=PROFILE)
    loaded = command(["sudo", "-n", "cat", "/sys/kernel/security/apparmor/profiles"])
    require(PROFILE_NAME + " (unconfined)" in loaded.splitlines(), "exact_profile_not_loaded")
    require(Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").read_text().strip() == restriction,
            "global_namespace_restriction_changed")
    require(ready(probe()), "namespace_probe_still_failed_after_exact_profile")
    return {"status": "ready", "profile_applied": True, "profile": PROFILE_NAME,
            "attachment": str(executable), "test_uid": os.geteuid(), "global_restriction": restriction}


if __name__ == "__main__":
    try:
        print(json.dumps(run(), sort_keys=True))
    except (OSError, subprocess.SubprocessError, Refused) as error:
        print(json.dumps({"status": "refused", "reason": str(error)[:1024]}, sort_keys=True))
        sys.exit(1)
