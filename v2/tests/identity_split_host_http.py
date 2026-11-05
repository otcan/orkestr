"""Actual HTTP + Root broker host/cwd/resume oracle; synthetic natives only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import identity_split_resume_http as resume
from identity_split_service_http import ROOT, UID, GID
from codex_service.package import CODE_MODE_HOST
from codex_bounded.trust import digest


class HostRehearsal(resume.ResumeRehearsal):
    def __init__(self, binary, provider='codex'):
        super().__init__(binary, provider)
        parent = self.fixture.directory('executor-private-projects')
        self.mapped = parent / 'conversation'; self.mapped.mkdir(mode=0o700)
        os.chown(self.mapped, UID, GID)
        # Core cannot traverse this directory. No project ACL/chown migration.
        self.envfile = self.fixture.root / 'host-tools.env'
        self.fixture.write_private(self.envfile, b'ORKESTR_SYNTHETIC_TOOL_ACCOUNT=present\n')
        beta_path = self.package.root / 'beta.json'; beta = json.loads(beta_path.read_text())
        beta['managed_host'] = {'environment': {'HOME': str(self.fixture.home),
            'CODEX_HOME': str(self.fixture.account), 'PATH': '/usr/bin:/bin'},
            'environment_files': [str(self.envfile)]}
        beta['conversation_workspaces'] = {self.package.conversation: str(self.mapped)}
        beta_path.write_text(json.dumps(beta))
        helper = self.package.root / CODE_MODE_HOST
        shutil.copyfile('/usr/bin/true', helper); helper.chmod(0o550)
        manifest_path = self.package.root / 'manifest.json'
        manifest = json.loads(manifest_path.read_text()); manifest['files'][helper.name] = digest(helper)
        manifest_path.write_text(json.dumps(manifest))
        if provider == 'codex': self.configure_host_native()
        else: self.trace_path = self.mapped / 'claude-peer.jsonl'
        self.refresh_manifest()

    def configure_host_native(self):
        # Derive only this disposable oracle's host protocol variant. This is
        # deliberately distinct from qualification of a real Codex account.
        source = (ROOT / 'v2/tests/selected_codex_roles_native.c').read_text()
        begin = source.index('    if (argc != 6')
        end = source.index('#ifdef ORKESTR_TEST_AUTHORITY_CORE', begin)
        source = source[:begin] + '''    if (argc != 4 || strcmp(argv[1],"app-server") ||
        strcmp(argv[2],"--listen") || strcmp(argv[3],"stdio://")) return 20;
    if (prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1 ||
        !getenv("ORKESTR_SYNTHETIC_TOOL_ACCOUNT") ||
        strcmp(getenv("ORKESTR_SYNTHETIC_TOOL_ACCOUNT"),"present")) return 21;
''' + source[end:]
        begin = source.index('    int fd = open("/account/auth.json", O_WRONLY);')
        end = source.index('    read_fixed("role"', begin)
        source = source[:begin] + source[end:]
        source = source.replace('#include <errno.h>', '#include <errno.h>\n#include <sys/prctl.h>')
        source = source.replace('/account/auth.json', str(self.fixture.auth))
        source = source.replace('/account', str(self.fixture.account))
        source = source.replace('readOnly', 'dangerFullAccess')
        generated = self.fixture.root / 'synthetic-managed-host.c'; generated.write_text(source)
        self.synthetic_sha256 = hashlib.sha256(source.encode()).hexdigest()
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
            '-DORKESTR_TEST_AUTHORITY_CORE=' + json.dumps(str(self.package.data / 'core.sqlite3')),
            str(generated), '-o', str(self.package.root / 'native')], check=True, capture_output=True,
            env={'PATH': '/usr/bin:/bin'})
        for name in ('role', 'mode'):
            self.fixture.write_private(self.mapped / name, (self.fixture.workspace / name).read_bytes())
        self.fixture.workspace = self.mapped

    def run(self):
        report = super().run()
        report.update(managed_host=True, mapped_executor_private_cwd=True,
            host_environment_file_by_reference=True, core_project_permissions_changed=False,
            synthetic_native_source_sha256=getattr(self, 'synthetic_sha256', None))
        return report


if __name__ == '__main__':
    resume.ResumeRehearsal = HostRehearsal
    resume.main()
