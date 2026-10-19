"""Opt-in trusted Codex profile. Root provisions paths; clients select none.

Canonical auth is mounted read-only, not copied. Only this selected auth file and
one private persistent session directory enter the trusted connector namespace.
The untrusted offline worker profile never receives either mount.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
from . import policy
from .launch import OwnedProvider
from .authenticated_budget import AUTHENTICATED


def private_path(path, directory=False):
    path=Path(path)
    if not path.is_absolute() or path.resolve(strict=True)!=path:
        raise ValueError("profile path must be canonical")
    for item in (path,*path.parents):
        info=item.stat()
        if info.st_uid not in (0,os.geteuid()) or info.st_mode & 0o022:
            raise ValueError("profile path ownership refused")
    info=path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError("profile path type refused")
    if info.st_mode & 0o077:
        raise ValueError("profile state must be private")
    return str(path)


def private_state(path):
    """Dedicated role state, never canonical home or copied account/config."""
    root=Path(private_path(path,True))
    disposable={"tmp","cache","skills","thread-writer-locks"}
    allowed={"sessions","archived_sessions","session_index.jsonl","auth.json",
             "models_cache.json","installation_id",".sandbox_migration"}|disposable
    for name in ("state_5.sqlite","logs_2.sqlite","goals_1.sqlite","memories_1.sqlite",
                 "queue_1.sqlite","thread_history_1.sqlite"):
        allowed.update((name,name+"-wal",name+"-shm",name+"-journal"))
    for item in root.iterdir():
        if item.name not in allowed or item.is_symlink():
            raise ValueError("unexpected private native state")
        info=item.lstat()
        expected_directory=item.name in ({"sessions","archived_sessions"}|disposable)
        if not (stat.S_ISDIR(info.st_mode) if expected_directory else stat.S_ISREG(info.st_mode)):
            raise ValueError("private native state type refused")
        if item.name in disposable and any(item.iterdir()):
            raise ValueError("disposable native state requires empty mountpoint")
        if item.name=="models_cache.json" and info.st_size>8*1024**2:
            raise ValueError("native model cache bound")
        if item.name in ("installation_id",".sandbox_migration") and info.st_size>4096:
            raise ValueError("native metadata bound")
        if item.name=="auth.json" and (not item.is_file() or item.stat().st_size!=0):
            raise ValueError("account copies forbidden in private state")
    count=0
    for directory,folders,files in os.walk(root,followlinks=False):
        for name in folders+files:
            count+=1
            item=Path(directory)/name
            info=item.lstat()
            if count>10000 or stat.S_ISLNK(info.st_mode) or info.st_uid not in (0,os.geteuid()) or info.st_mode & 0o022:
                raise ValueError("unsafe private native state")
            if stat.S_ISREG(info.st_mode) and info.st_nlink!=1:
                raise ValueError("private native state hardlink refused")
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError("unsafe private native state")
    return str(root)


class SelectedCodexProfile:
    """Server-private immutable configuration, never deserialize request JSON here."""
    _provider="codex"

    def __init__(self, configuration, *, workspace_descriptor=None):
        path=Path(configuration)
        if path.resolve(strict=True)!=path or not path.is_file():
            raise ValueError("immutable profile required")
        for item in (path,*path.parents):
            info=item.stat()
            if info.st_uid!=0 or info.st_mode & 0o022:
                raise ValueError("immutable profile required")
        value=json.loads(Path(path).read_text())
        fields={"format","native","egress_socket","supervisor","hosts","workspace"}
        if self._provider=="codex":fields.add("auth_file")
        if not isinstance(value,dict):
            raise ValueError("invalid selected profile")
        modern=value.get("format")=="orkestr-v2-codex-isolated-v2" or self._provider=="claude"
        fields.add("state_root" if modern else "sessions")
        formats=("orkestr-v2-codex-isolated-v1","orkestr-v2-codex-isolated-v2") if self._provider=="codex" else ("orkestr-v2-claude-isolated-v1",)
        if set(value)!=fields or value["format"] not in formats:
            raise ValueError("invalid selected profile")
        policy.trusted("/etc/ssl/certs",True)
        certificate=Path("/etc/ssl/certs/ca-certificates.crt").stat()
        if certificate.st_uid!=0 or certificate.st_mode & 0o022:
            raise ValueError("untrusted public trust store")
        self.native=policy.trusted(value["native"])
        with open(self.native,"rb") as executable:
            if executable.read(4)!=b"\x7fELF":
                raise ValueError("canonical native ELF required")
        self.supervisor=policy.trusted(value["supervisor"])
        # Sibling budget module is part of the immutable installed inventory.
        budget=Path(self.supervisor).with_name("authenticated_budget.py")
        for item in (budget,*budget.parents):
            info=item.stat()
            if info.st_uid!=0 or info.st_mode & 0o022:
                raise ValueError("untrusted authenticated budget")
        self.auth=private_path(value["auth_file"]) if self._provider=="codex" else None
        if self.auth is not None and Path(self.auth).name!="auth.json":
            raise ValueError("selected canonical Codex auth file required")
        self.state_root=self._state(value["state_root"]) if modern else None
        self.sessions=None if modern else private_path(value["sessions"],True)
        if workspace_descriptor is None:
            self.workspace=private_path(value["workspace"],True)
        else:
            from .workspace_fd import InheritedWorkspace, logical_workspace
            if type(workspace_descriptor) is not InheritedWorkspace:
                raise ValueError("issued workspace descriptor required")
            workspace_descriptor.validate()
            self.workspace=logical_workspace(value["workspace"])
        self._workspace_descriptor=workspace_descriptor
        endpoint=Path(value["egress_socket"])
        if endpoint.resolve(strict=True)!=endpoint or not stat.S_ISSOCK(endpoint.stat().st_mode):
            raise ValueError("private egress endpoint required")
        # The root-owned parent is the endpoint authority; same-UID writable
        # directories could substitute an unrestricted proxy after validation.
        policy.trusted(endpoint.parent,True)
        if endpoint.stat().st_uid!=0 or endpoint.stat().st_mode & 0o007:
            raise ValueError("untrusted egress endpoint")
        self.endpoint=str(endpoint)
        hosts=value["hosts"]
        if not isinstance(hosts,list) or not 0<len(hosts)<=8 or any(
            not isinstance(h,str) or not h or len(h)>253 or
            any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in h) or
            "." not in h for h in hosts):
            raise ValueError("invalid exact egress hosts")
        self.hosts=tuple(hosts)

    _state=staticmethod(private_state)

    def start(self):
        return self._start(None)

    def _start(self, synthetic_source):
        """Synthetic source is test-only; production start has no command input."""
        fd=policy.filter_fd(allow_inet=True)
        try:
            argv=self._command(fd,"synthetic" if synthetic_source is not None else "codex")
            child=subprocess.Popen(argv,env={},cwd="/",close_fds=True,pass_fds=(fd,),
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            owned=OwnedProvider(child)
            try:
                for pipe in (child.stdin,child.stdout,child.stderr):os.set_blocking(pipe.fileno(),False)
                if synthetic_source is not None:
                    # Test helper source is stdin, never public production argv.
                    os.write(child.stdin.fileno(),synthetic_source.encode()+b"\n")
                return owned
            except BaseException:
                owned.close();raise
        finally:os.close(fd)

    def _command(self, fd, mode):
        argv=policy.command(self.native,(),fd)
        # Explicit authenticated budget, never relax the offline command builder.
        replacements={"--cpu=3:3":f"--cpu={AUTHENTICATED.cpu_seconds}:{AUTHENTICATED.cpu_seconds}",
            "--as=1073741824:1073741824":f"--as={AUTHENTICATED.address_bytes}:{AUTHENTICATED.address_bytes}",
            "--fsize=8388608:8388608":f"--fsize={AUTHENTICATED.file_bytes}:{AUTHENTICATED.file_bytes}",
            "--nofile=64:64":f"--nofile={AUTHENTICATED.descriptors}:{AUTHENTICATED.descriptors}"}
        argv=[replacements.get(argument,argument) for argument in argv]
        # Supervisor needs process/socket primitives; strict filter is loaded
        # only by its exec-only native launcher, before provider exec.
        index=argv.index("--seccomp")
        del argv[index:index+2]
        start=argv.index("--",argv.index("--clearenv"))
        argv[start+1:]=["/usr/bin/python3","-I","-B","/opt/provider/supervisor.py",
            str(fd),",".join(self.hosts),mode]
        workspace=getattr(self,"_workspace_descriptor",None)
        if workspace is None:
            workspace_mounts=["--ro-bind",self.workspace,self.workspace]
            argv[argv.index("--chdir")+1]=self.workspace
        else:
            # Capability is the retained open description, never config cwd.
            help_result=subprocess.run([policy.trusted("/usr/bin/bwrap"),"--help"],
                env={},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,timeout=2,check=True)
            arguments=workspace.mount_arguments(help_result.stdout)
            workspace_mounts=list(arguments[:3])
            argv[argv.index("--chdir")+1]=arguments[-1]
        mounts=workspace_mounts+["--ro-bind",self.supervisor,"/opt/provider/supervisor.py",
            "--ro-bind",str(Path(self.supervisor).with_name("authenticated_budget.py")),
            "/opt/provider/authenticated_budget.py",
            "--ro-bind",self.endpoint,"/run/provider-egress.sock",
            "--ro-bind","/etc/ssl/certs/ca-certificates.crt",
            "/etc/ssl/certs/ca-certificates.crt"]
        if getattr(self,"state_root",None) is not None:
            mounts += ["--bind",self.state_root,"/account"]
        else:
            mounts += ["--bind",self.sessions,"/account/sessions"]
        if self._provider=="codex":
            # Native helper symlinks and downloaded skills/cache never persist
            # into the next launch. Empty host mountpoints only, never traversal.
            for name in ("tmp","cache","skills","thread-writer-locks"):
                mounts += ["--size","33554432","--tmpfs","/account/"+name]
        if self.auth is not None:
            mounts += ["--ro-bind",self.auth,"/account/auth.json"]
        mount_index=argv.index("--chdir")
        argv[mount_index:mount_index]=mounts
        return argv

    def exec_native(self):
        """Fixed private launcher wrapper calls this, never browser/client code.

        Exec preserves the broker-created stdin pipe and process ownership;
        supervisor and native only inherit its read end. The canonical provider
        account is selected solely by this already validated private profile.
        """
        fd=policy.filter_fd(allow_inet=True)
        try:
            argv=self._command(fd,"codex")
            os.set_inheritable(fd,True)
            os.execve(argv[0],argv,{})
        finally:os.close(fd)


def launcher_main(configuration):
    """Root wrapper supplies a fixed private path, not an env/argv selector."""
    import sys
    if sys.argv[1:]!=["app-server","--listen","stdio://"]:
        return 2
    try:SelectedCodexProfile(configuration).exec_native()
    except Exception:return 2
    return 2
