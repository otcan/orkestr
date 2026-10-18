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


class SelectedCodexProfile:
    """Server-private immutable configuration, never deserialize request JSON here."""
    def __init__(self, configuration):
        path=Path(configuration)
        if path.resolve(strict=True)!=path or not path.is_file():
            raise ValueError("immutable profile required")
        for item in (path,*path.parents):
            info=item.stat()
            if info.st_uid!=0 or info.st_mode & 0o022:
                raise ValueError("immutable profile required")
        value=json.loads(Path(path).read_text())
        if not isinstance(value,dict) or set(value)!={"format","native","auth_file","sessions","egress_socket","supervisor","hosts","workspace"}:
            raise ValueError("invalid selected profile")
        if value["format"]!="orkestr-v2-codex-isolated-v1":
            raise ValueError("unsupported selected profile")
        policy.trusted("/etc/ssl/certs",True)
        certificate=Path("/etc/ssl/certs/ca-certificates.crt").stat()
        if certificate.st_uid!=0 or certificate.st_mode & 0o022:
            raise ValueError("untrusted public trust store")
        self.native=policy.trusted(value["native"])
        with open(self.native,"rb") as executable:
            if executable.read(4)!=b"\x7fELF":
                raise ValueError("canonical native ELF required")
        self.supervisor=policy.trusted(value["supervisor"])
        self.auth=private_path(value["auth_file"])
        if Path(self.auth).name!="auth.json":
            raise ValueError("selected canonical Codex auth file required")
        self.sessions=private_path(value["sessions"],True)
        self.workspace=private_path(value["workspace"],True)
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
        # Supervisor needs process/socket primitives; strict filter is loaded
        # only by its exec-only native launcher, before provider exec.
        index=argv.index("--seccomp")
        del argv[index:index+2]
        start=argv.index("--",argv.index("--clearenv"))
        argv[start+1:]=["/usr/bin/python3","-I","-B","/opt/provider/supervisor.py",
            str(fd),",".join(self.hosts),mode]
        argv[argv.index("--chdir")+1]=self.workspace
        mounts=["--ro-bind",self.workspace,self.workspace,"--ro-bind",self.supervisor,"/opt/provider/supervisor.py",
            "--ro-bind",self.auth,"/account/auth.json",
            "--bind",self.sessions,"/account/sessions",
            "--ro-bind",self.endpoint,"/run/provider-egress.sock",
            "--ro-bind","/etc/ssl/certs/ca-certificates.crt",
            "/etc/ssl/certs/ca-certificates.crt"]
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
