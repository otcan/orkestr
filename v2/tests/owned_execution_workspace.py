"""Disposable ordinary descriptor setup/resume. No selected account or provider.

The fixed synthetic launcher mounts only the granted descriptor at /workspace.
Its broad synthetic filesystem view is NOT authenticated-profile qualification.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from owned_execution_http import broker, wait_for
from owned_execution_recovery import RecoveryCase, accept, counts, stop_intent


class WorkspaceCase(RecoveryCase):
    def configure_mode(self, mode):
        self.stop()
        self.configure()
        subprocess.run(["git", "init", "-q", str(self.workspace)], check=True,
                       env={"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1",
                            "GIT_CONFIG_GLOBAL": "/dev/null"})
        native = Path(__file__).with_name("owned_execution_recovery_peer.py").read_text()
        # This fixture has no selected account, environment or actual provider.
        start = native.index('assert set(os.environ)')
        end = native.index('prior = ', start)
        native = native[:start] + (
            'assert os.getcwd() == "/workspace"\n'
            'try:\n    Path("must-not-write").write_text("forbidden")\n'
            'except OSError as error:\n    assert error.errno == 30\n'
            'else:\n    raise AssertionError("workspace mount is writable")\n'
            'assert not Path("/proc/self/fd/5").exists()\n'
            f'trace = Path({str(self.workspace / "synthetic-peer.jsonl")!r})\n') + native[end:]
        native = native.replace('Path("recovery-mode")', 'Path(' + repr(str(self.workspace / "recovery-mode")) + ')')
        native = native.replace("    method = frame[\"method\"]", "    record(\"rpc\", frame=frame)\n    method = frame[\"method\"]")
        (self.root / "synthetic-provider").write_text(native)
        (self.workspace / "recovery-mode").write_text(mode)
        launcher = self.root / "synthetic-launcher"
        launcher.write_text("#!/usr/bin/python3\nimport os,sys\nfrom pathlib import Path\n"
            f"sys.path.insert(0,{str(broker)!r})\n"
            "from isolation.workspace_fd import InheritedWorkspace\n"
            "from codex_bounded.broker import pump_type\n"
            "from reaping import become_subreaper\nimport server\n"
            "operations={'open-owned-workspace-session':'open-owned-session',"
            "'resume-owned-workspace-session':'resume-owned-session'}\n"
            "assert len(sys.argv)==4 and sys.argv[1] in operations\n"
            "assert sys.argv[2:]==['--protocol','orkestr-v2-provider-broker-v1']\n"
            "workspace=InheritedWorkspace()\n"
            "class Config:\n    workspace='/workspace'\n    workspace_descriptor=workspace\n"
            "    def isolated_command(self):\n"
            "        return ['/usr/bin/bwrap','--unshare-user','--unshare-pid',"
            "'--die-with-parent','--bind','/','/','--proc','/proc',"
            "'--ro-bind-fd','5','/workspace','--chdir','/workspace',"
            f"'/usr/bin/python3',{str(self.root / 'synthetic-provider')!r},'app-server','--listen','stdio://'],(5,)\n"
            "server.Configuration.load=lambda _:Config()\n"
            "server.Pump=pump_type(server.Pump,become_subreaper)\n"
            "sys.argv[1]=operations[sys.argv[1]]\n"
            "raise SystemExit(server.main())\n")
        config_file = self.root / "execution.json"
        config = json.loads(config_file.read_text())
        config["launcher_sha256"] = hashlib.sha256(launcher.read_bytes()).hexdigest()
        config["workspace_authority"] = {
            "project_id": "11111111-2222-4333-8444-555555555555",
            "allowed_roots": [str(self.workspace)], "protected_roots": [str(self.home)],
        }
        config_file.write_text(json.dumps(config))
        self.start(configured=True)


def stopped_fresh_resume(case):
    case.configure_mode("stop")
    running, _, _, _ = stop_intent(case)
    wait_for(lambda: case.phase("cancelled"), "genuine stopped descriptor turn")
    wait_for(case.peer_gone, "original native tree reaped before descriptor resume")
    assert case.rows("SELECT state FROM workspace_launches") == [("delivery_unknown",)]
    assert case.message(3)[0] == 202
    second = wait_for(lambda: case.phase("awaiting_acceptance"), "fresh descriptor resume proposal")
    assert second["run_id"] != running["run_id"]
    counts(case, 2, [1, 3])
    assert case.rows("SELECT count(DISTINCT native_session_id) FROM production_runs") == [(1,)]
    assert case.rows("SELECT count(*) FROM workspace_launches WHERE state='delivery_unknown'") == [(2,)]
    accept(case, second, "descriptor-resume-accept")
    case.clean_stop()


if __name__ == "__main__":
    case = WorkspaceCase()
    try:
        case.setup()
        stopped_fresh_resume(case)
        print("ordinary descriptor Stop/fresh-resume passed")
    finally:
        case.cleanup()
