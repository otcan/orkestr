"""Isolated owned provider launch. No root, production units, or account mounts."""
import os
import selectors
import signal
import subprocess
import time
from . import policy


class ProviderSandbox:
    """Offline/stdio provider boundary, opt-in from trusted composition only.

    No caller mounts, environment, network or inherited FD options. Canonical
    account data stays outside; only stdio reaches the designated broker.
    Native provider network/auth mediation is a separate integration gate.
    """
    def __init__(self):
        policy.trusted("/usr/bin/bwrap")

    def start_python(self, source):
        if not isinstance(source,str) or not 0 < len(source.encode()) <= 65536 or "\0" in source:
            raise ValueError("invalid synthetic provider source")
        return self._spawn(policy.trusted("/usr/bin/python3"),("-I","-B","-c",source))

    def start_codex_offline(self, executable):
        """Fixed native setup entry; intentionally no account/network access."""
        return self._spawn(policy.trusted(executable),("app-server","--listen","stdio://"))

    def start_claude_offline(self, executable, native):
        """New native identity only; no resume, auth or arbitrary flags."""
        import uuid
        if not isinstance(native,uuid.UUID):
            raise ValueError("invalid private native identity")
        arguments=("-p","--input-format","stream-json","--output-format","stream-json",
            "--verbose","--permission-mode","dontAsk","--permission-prompts","none",
            "--safe-mode","--restricted","--disable-slash-commands","--no-chrome",
            "--prompt-suggestions","false","--tools","","--strict-mcp-config",
            "--mcp-config",'{"mcpServers":{}}',"--setting-sources","","--session-id",str(native))
        return self._spawn(policy.trusted(executable),arguments)

    def _spawn(self, executable, arguments):
        fd = policy.filter_fd()
        try:
            argv = policy.command(executable,arguments,fd)
            child = subprocess.Popen(argv,env={},cwd="/",close_fds=True,pass_fds=(fd,),
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                start_new_session=True)
            # Install ownership immediately. All subsequent setup may fail.
            owned = OwnedProvider(child)
            try:
                for pipe in (child.stdin,child.stdout,child.stderr):
                    os.set_blocking(pipe.fileno(),False)
                return owned
            except BaseException:
                owned.close()
                raise
        finally:
            os.close(fd)


class OwnedProvider:
    def __init__(self,child):
        self._child = child
        self._closed = False

    @property
    def pid(self):
        return self._child.pid

    def exchange(self, payload=b"", timeout=2, max_output=65536, cancelled=lambda:False):
        """Bounded synthetic stdio exercise, NOT a Core-fenced inference pump."""
        if not isinstance(payload,bytes) or len(payload)>65536 or not 0<timeout<=5 or not 0<max_output<=131072:
            raise ValueError("invalid bounded provider exchange")
        child = self._child
        output,errors = bytearray(),bytearray()
        offset = 0
        deadline = time.monotonic()+timeout
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout,selectors.EVENT_READ,output)
                selector.register(child.stderr,selectors.EVENT_READ,errors)
                if payload:
                    selector.register(child.stdin,selectors.EVENT_WRITE,None)
                else:
                    child.stdin.close()
                while selector.get_map():
                    if cancelled():
                        raise InterruptedError("owned provider cancelled")
                    remaining = deadline-time.monotonic()
                    if remaining<=0:
                        raise TimeoutError("owned provider deadline")
                    for key,event in selector.select(min(remaining,0.02)):
                        if event & selectors.EVENT_WRITE:
                            try:
                                count=os.write(key.fd,payload[offset:offset+4096])
                            except BlockingIOError:
                                continue
                            if count<=0:
                                raise OSError("provider write failed")
                            offset+=count
                            if offset==len(payload):
                                selector.unregister(key.fileobj)
                                child.stdin.close()
                        else:
                            try:
                                data=os.read(key.fd,4096)
                            except BlockingIOError:
                                continue
                            if not data:
                                selector.unregister(key.fileobj)
                            else:
                                key.data.extend(data)
                                if len(output)+len(errors)>max_output:
                                    raise BufferError("owned provider output bound")
            code=child.wait(timeout=max(0.001,deadline-time.monotonic()))
            return code,bytes(output),bytes(errors)
        finally:
            self.close()

    def close(self):
        if self._closed:
            return
        self._closed=True
        child=self._child
        # PID namespace owns descendants; killing the owned bwrap leader kills
        # the namespace child via die-with-parent. No production PID lookup.
        if child.returncode is None:
            try:
                os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait(timeout=2)
        for pipe in (child.stdin,child.stdout,child.stderr):
            pipe.close()

    def __enter__(self):
        return self

    def __exit__(self,*_exc):
        self.close()
