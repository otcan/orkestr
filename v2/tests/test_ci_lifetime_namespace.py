"""Policy decisions only: no kernel writes, real namespace or privileged child."""
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import ci_lifetime_namespace as policy


class HostedPolicyTests(unittest.TestCase):
    def test_denial_must_be_new_exact_pid_and_default_userns_profile(self):
        line = 'audit: apparmor="DENIED" profile="unprivileged_userns" pid=123 comm="bwrap"'
        self.assertEqual(policy.matching_denials("", line, 123), [line])
        for before, after in ((line, line), ("", line.replace("123", "1234")),
                              ("", line.replace("unprivileged_userns", "existing-custom-profile")),
                              ("", line.replace('comm="bwrap"', 'comm="other"'))):
            self.assertEqual(policy.matching_denials(before, after, 123), [])

    def exercise(self, *, denial=True, restriction="1", existing=False, first_ready=False, final_ready=True):
        commands = []
        reads = {"/etc/os-release": "ID=ubuntu\n", "/proc/self/attr/current": "unconfined\n",
                 "/sys/module/apparmor/parameters/enabled": "Y\n",
                 "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": restriction}
        denied = 'audit: apparmor="DENIED" profile="unprivileged_userns" pid=123 comm="bwrap"'
        result = {"pid": 123, "code": 1, "output": "", "error": "bwrap: setting up uid map: Permission denied"}
        ok = {**result, "code": 0, "output": "orkestr-lifetime-namespace-ready\n", "error": ""}
        installed = False
        kernel_reads = 0
        def command(args, *, data=None):
            nonlocal installed, kernel_reads
            commands.append((args, data))
            if args[-1] == "--raw":
                kernel_reads += 1
                return denied if kernel_reads > 1 and denial else ""
            if "apparmor_parser" in args:
                self.assertEqual(args, ["sudo", "-n", "apparmor_parser", "--add", "--skip-cache"])
                self.assertEqual(data, policy.PROFILE)
                installed = True
                return ""
            return (policy.PROFILE_NAME + " (unconfined)\n" if installed else
                    "/usr/bin/bwrap (enforce)\n" if existing else "unprivileged_userns (enforce)\n")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                                   "RUNNER_OS": "Linux"}, clear=True), \
                patch.object(policy.os, "geteuid", return_value=1001), \
                patch.object(Path, "exists", return_value=False), \
                patch.object(Path, "resolve", lambda path: path), \
                patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=0o100755)), \
                patch.object(Path, "read_text", lambda path: reads[str(path)]), \
                patch.object(policy, "command", command), \
                patch("builtins.print"), \
                patch.object(policy, "probe", side_effect=[ok if first_ready else result, ok if final_ready else result]):
            try:
                return policy.run(), commands
            except policy.Refused as error:
                return str(error), commands

    def test_working_namespace_does_not_load_any_profile(self):
        result, commands = self.exercise(first_ready=True)
        self.assertFalse(result["profile_applied"])
        self.assertFalse(any("apparmor_parser" in args for args, _ in commands))

    def test_proven_denial_loads_only_fixed_attachment_then_requires_real_probe(self):
        result, commands = self.exercise()
        self.assertTrue(result["profile_applied"])
        self.assertEqual(sum("apparmor_parser" in args for args, _ in commands), 1)
        self.assertNotEqual(result["test_uid"], 0)
        self.assertEqual(result["global_restriction"], "1")
        result, _ = self.exercise(final_ready=False)
        self.assertEqual(result, "namespace_probe_still_failed_after_exact_profile")

    def test_unevidenced_failure_and_existing_policy_remain_red_without_mutation(self):
        for values in ({"denial": False}, {"restriction": "0"}, {"existing": True}):
            result, commands = self.exercise(**values)
            self.assertIsInstance(result, str)
            self.assertFalse(any("apparmor_parser" in args for args, _ in commands))

    def test_default_invocation_and_self_hosted_runner_refuse_before_commands(self):
        for values in ({}, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted", "RUNNER_OS": "Linux"}):
            with patch.dict(os.environ, values, clear=True), patch.object(policy, "command") as command:
                with self.assertRaises(policy.Refused):
                    policy.run()
                command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
