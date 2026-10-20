#!/usr/bin/python3
"""Trusted namespace supervisor; root stages this immutable alongside profile.

No authentication contents are read here. Native cannot open AF_UNIX; only this
supervisor accesses the designated root-side egress endpoint. That endpoint MUST
independently enforce the same exact-host/443 policy and public-address-only DNS.
"""
import ctypes
import os
import selectors
import socket
import subprocess
import sys
import threading
import time

if __package__:
    from .authenticated_budget import AUTHENTICATED
else:
    sys.path.insert(0,"/opt/provider")
    from authenticated_budget import AUTHENTICATED

MAX_BYTES=AUTHENTICATED.tunnel_bytes
MAX_CONNECTIONS=AUTHENTICATED.connections


def destination(header,hosts):
    if len(header)>4096 or not header.endswith(b"\r\n\r\n"):
        raise ValueError("proxy request refused")
    lines=header.decode("ascii").split("\r\n")
    words=lines[0].split(" ")
    if len(words)!=3 or words[0]!="CONNECT" or words[2]!="HTTP/1.1":
        raise ValueError("proxy method refused")
    target=words[1]
    if target not in {h+":443" for h in hosts}:
        raise ValueError("proxy destination refused")
    # Do not forward caller headers, credentials, Host ambiguities or framing.
    return f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode()


def relay(client,hosts,endpoint="/run/provider-egress.sock"):
    upstream=None
    try:
        client.settimeout(2)
        header=bytearray()
        while not header.endswith(b"\r\n\r\n"):
            chunk=client.recv(1)
            if not chunk:raise ValueError("truncated proxy request")
            header.extend(chunk)
            if len(header)>4096:raise ValueError("proxy header bound")
        request=destination(bytes(header),hosts)
        upstream=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        upstream.settimeout(2);upstream.connect(endpoint);upstream.sendall(request)
        client.setblocking(False);upstream.setblocking(False)
        deadline=time.monotonic()+AUTHENTICATED.tunnel_seconds
        count=0
        with selectors.DefaultSelector() as selector:
            selector.register(client,selectors.EVENT_READ,upstream)
            selector.register(upstream,selectors.EVENT_READ,client)
            while time.monotonic()<deadline:
                ready=selector.select(min(.1,max(0,deadline-time.monotonic())))
                for key,_ in ready:
                    try:data=key.fileobj.recv(16384)
                    except BlockingIOError:continue
                    if not data:return
                    count+=len(data)
                    if count>MAX_BYTES:return
                    # Bounded suffix forwarding; no inference or Core authority
                    # is represented by this TLS byte tunnel.
                    view=memoryview(data)
                    while view and time.monotonic()<deadline:
                        try:n=key.data.send(view)
                        except BlockingIOError:
                            with selectors.DefaultSelector() as writable:
                                writable.register(key.data,selectors.EVENT_WRITE)
                                writable.select(.05)
                            continue
                        if n<=0:return
                        view=view[n:]
                    if view:return
    except (OSError,ValueError,UnicodeError):
        pass
    finally:
        client.close()
        if upstream is not None:upstream.close()


class RelayAdmission:
    """Single accept-loop owner; no payload inspection or queued connections."""
    def __init__(self):
        self.workers=[]
        self.reported=False

    def admit(self,client,hosts):
        # Sample after accept returns: a relay may exit while accept blocks.
        # Only this loop starts workers, so pruning cannot over-admit.
        self.workers=[worker for worker in self.workers if worker.is_alive()]
        if len(self.workers)>=MAX_CONNECTIONS:
            client.close()
            # Fixed, bounded diagnostic only. No destination, account, address,
            # native error, TLS bytes or caller-controlled text can enter it.
            if not self.reported:
                self.reported=True
                try:os.write(2,b"provider-egress: inner-capacity-refused\n")
                except OSError:pass
            return False
        worker=threading.Thread(target=relay,args=(client,hosts),daemon=True)
        self.workers.append(worker)
        worker.start()
        return True


def install_filter(fd):
    raw=os.read(fd,65536);os.close(fd)
    if not raw or len(raw)%8:raise ValueError("invalid sealed filter")
    class Program(ctypes.Structure):
        _fields_=[("length",ctypes.c_ushort),("instructions",ctypes.c_void_p)]
    instructions=ctypes.create_string_buffer(raw)
    program=Program(len(raw)//8,ctypes.addressof(instructions))
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(38,1,0,0,0)!=0 or libc.prctl(22,2,ctypes.byref(program),0,0)!=0:
        raise OSError("native filter refused")


def main():
    if len(sys.argv)==4 and sys.argv[1] in ("claude-native","claude-resume-native"):
        import uuid
        native=str(uuid.UUID(sys.argv[3]))
        install_filter(int(sys.argv[2]))
        command=["native","-p","--input-format","stream-json","--output-format","stream-json",
            "--verbose","--permission-mode","dontAsk","--permission-prompts","none",
            "--safe-mode","--restricted","--disable-slash-commands","--no-chrome",
            "--prompt-suggestions","false","--tools","","--strict-mcp-config",
            "--mcp-config",'{"mcpServers":{}}',"--setting-sources","",
            "--resume" if sys.argv[1]=="claude-resume-native" else "--session-id",native]
        os.execve("/opt/provider/native",command,dict(os.environ))
    if len(sys.argv)==3 and sys.argv[1] in ("native","native-bounded"):
        install_filter(int(sys.argv[2]))
        # This explicit isolated acceptance role has no plugin tools. Legacy
        # Codex/Claude roles keep their existing configuration and budget.
        # The installed filter refuses every subprocess, so Codex's out-of-process
        # code-mode host can never start here. Keep dynamic tools (for example
        # orkestr_workspace_exec) as direct function calls instead of failing
        # with EPERM before the tool request reaches the broker.
        options=(["-c","features.plugins=false","-c","features.code_mode=false",
                  "-c","features.code_mode_host=false"] if sys.argv[1]=="native-bounded" else [])
        os.execve("/opt/provider/native",["native",*options,"app-server","--listen","stdio://"],dict(os.environ))
    claude=len(sys.argv)==6 and sys.argv[3] in ("claude","claude-resume","claude-synthetic")
    if not claude and (len(sys.argv)!=4 or sys.argv[3] not in ("codex","codex-bounded","synthetic")):return 2
    bounded=sys.argv[3]=="codex-bounded"
    if bounded:
        from bounded_proxy import Inner
    fd=int(sys.argv[1]);hosts=tuple(sys.argv[2].split(","))
    listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    listener.bind(("127.0.0.1",0));listener.listen(MAX_CONNECTIONS);listener.settimeout(.05)
    proxy="http://127.0.0.1:"+str(listener.getsockname()[1])
    environment={"PATH":"/usr/bin","HOME":"/home/provider","TMPDIR":"/tmp",
        "LANG":"C.UTF-8","CODEX_HOME":"/account","HTTPS_PROXY":proxy,
        "HTTP_PROXY":proxy,"ALL_PROXY":proxy,"NO_PROXY":""}
    if claude:
        secret=int(sys.argv[5])
        try:
            raw=os.read(secret,16385)
            if not 0<len(raw)<=16384 or b"\0" in raw or b"\n" in raw or os.read(secret,1):
                raise ValueError("selected account refused")
            token=raw.decode("utf-8")
        finally:os.close(secret)
        environment.pop("CODEX_HOME")
        environment["CLAUDE_CONFIG_DIR"]="/account"
        environment["CLAUDE_CODE_OAUTH_TOKEN"]=token
    if sys.argv[3] in ("synthetic","claude-synthetic"):
        # Only used by isolated synthetic tests; no production source parameter.
        source=bytearray()
        while not source.endswith(b"\n"):
            chunk=os.read(sys.stdin.fileno(),1)
            if not chunk:return 2
            source.extend(chunk)
            if len(source)>65536:return 2
        command=["/usr/bin/python3","-I","-B","-c",
            "import sys;sys.path.insert(0,'/opt/provider');from supervisor import install_filter;"
            "install_filter(int(sys.argv[1]));exec(sys.argv[2])",str(fd),source.decode()]
    elif claude:command=["/usr/bin/python3","-I","-B",__file__,
        "claude-resume-native" if sys.argv[3]=="claude-resume" else "claude-native",str(fd),sys.argv[4]]
    else:command=["/usr/bin/python3","-I","-B",__file__,
        "native-bounded" if sys.argv[3]=="codex-bounded" else "native",str(fd)]
    child=subprocess.Popen(command,env=environment,close_fds=True,pass_fds=(fd,),stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr)
    os.close(fd)
    if bounded:
        admission=Inner(hosts)
    else:admission=RelayAdmission()
    try:
        while child.poll() is None:
            if bounded:admission.poll()
            try:client,_=listener.accept()
            except socket.timeout:continue
            if bounded:admission.admit(client,time.monotonic_ns())
            else:admission.admit(client,hosts)
        return child.wait()
    finally:
        listener.close()
        if child.poll() is None:child.kill();child.wait(timeout=1)
        if bounded:admission.close()


if __name__=="__main__":
    try:raise SystemExit(main())
    except Exception:sys.stderr.write("isolated provider refused\n");raise SystemExit(2)
