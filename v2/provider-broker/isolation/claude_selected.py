"""Opt-in trusted selected-account Claude profile; no client account selector."""
import fcntl
import os
import uuid
from .authenticated import SelectedCodexProfile, private_path
from . import policy
from .claude_state import state_root, projects


class SelectedAccount:
    """Single-use callback result, bound to one private profile object."""
    __slots__=("_profile","_token")

    def __init__(self, profile, callback):
        selected=callback()
        if not isinstance(selected,dict) or set(selected)!={"CLAUDE_CODE_OAUTH_TOKEN"}:
            raise ValueError("selected subscription required")
        token=selected["CLAUDE_CODE_OAUTH_TOKEN"]
        if not isinstance(token,str) or not 0<len(token.encode())<=16384 or "\0" in token or "\n" in token:
            raise ValueError("invalid selected subscription")
        self._profile,self._token=profile,token

    def __reduce__(self):raise TypeError("private account capability")
    def __copy__(self):raise TypeError("private account capability")
    def __deepcopy__(self, memo):raise TypeError("private account capability")

    def _take(self, profile):
        token,self._token=self._token,None
        if profile is not self._profile or token is None:
            raise ValueError("selected account already consumed or foreign")
        fd=os.memfd_create("selected-account",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
        try:
            os.write(fd,token.encode());os.lseek(fd,0,os.SEEK_SET)
            fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|
                        fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
            return fd
        except BaseException:
            os.close(fd);raise


class SelectedClaudeProfile(SelectedCodexProfile):
    _provider="claude"

    _state = staticmethod(state_root)

    def _command(self, fd, mode):
        # Never remount generated account/settings/telemetry into the next child.
        argv=super()._command(fd,mode)
        index=argv.index(self.state_root)
        argv[index-1:index+2]=['--size','268435456','--tmpfs','/account',
            '--bind',projects(self.state_root,self.workspace),'/account/projects']
        return argv

    def start(self):
        raise ValueError("selected Claude launch requires private account capability")

    def _start(self, synthetic_source):
        raise ValueError("Codex start unavailable for Claude profile")

    def selected_account(self, callback):
        return SelectedAccount(self,callback)

    def exec_resume(self, account, resume_spec):
        from claude_resume import ResumeSpec
        if type(resume_spec) is not ResumeSpec:raise ValueError('private resume specification required')
        native=str(resume_spec._take(self))
        projects(self.state_root,self.workspace,native)
        self._exec(account,native,'claude-resume')

    def exec_native(self, account, native):
        self._exec(account,native,'claude')

    def _exec(self, account, native, mode):
        # Called only from trusted selected launcher; UUID is not Core proof.
        native=str(uuid.UUID(str(native)))
        if type(account) is not SelectedAccount:raise ValueError("selected account required")
        secret=account._take(self)
        fd=None
        try:
            if mode=='claude':projects(self.state_root,self.workspace,fresh=True)
            fd=policy.filter_fd(allow_inet=True)
            argv=self._command(fd,mode)
            argv += [native,str(secret)]
            os.set_inheritable(fd,True);os.set_inheritable(secret,True)
            os.execve(argv[0],argv,{})
        finally:
            os.close(secret)
            if fd is not None:os.close(fd)
