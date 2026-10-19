"""Test-only exact-peer server. No package, account, provider or TCP startup."""
import json
from pathlib import Path
import select
import subprocess


SERVER = r'''
import json,os,signal,socket,struct,subprocess,sys,threading,time
from pathlib import Path
config = CONFIG
child = None
waiter = None
def expired(*_args):
    raise TimeoutError("synthetic server deadline")
signal.signal(signal.SIGALRM, expired)
signal.signal(signal.SIGTERM, expired)
signal.alarm(8)
def identity(pid):
    parts=Path(f"/proc/{pid}/stat").read_text().rsplit(")",1)[1].split()
    return {"pid":pid,"start":int(parts[19]),"uid":os.getuid(),"ppid":int(parts[1]),"state":parts[0]}
try:
    connection=socket.socket(socket.AF_UNIX)
    connection.settimeout(5)
    connection.connect(config["endpoint"])
    # Signal readiness before any frame bytes; Manager.once must charge this
    # wait to the original caller deadline, not renew at receive completion.
    print(json.dumps({"connected":True}),flush=True)
    time.sleep(config["frame_delay"])
    previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM,signal.SIGALRM})
    try:
        child=subprocess.Popen([str(Path("/usr/bin/python3").resolve()),"-I","-S","-B",
            config["entry"],"broker","open-owned-session","--protocol","orkestr-v2-provider-broker-v1"],
            env={"PATH":"/usr/bin:/bin"},stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK,previous)
    broker=identity(child.pid)
    Path(config["ownership"]).write_text(json.dumps(broker))
    waiter=threading.Thread(target=child.wait)
    waiter.start()
    request=config["request"]
    request.update(broker_pid=broker["pid"],broker_start=broker["start"])
    raw=json.dumps(request,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    answer=None
    try:
        connection.sendall(struct.pack("!I",len(raw))+raw)
        def read(size):
            result=b""
            while len(result)<size:
                part=connection.recv(size-len(result))
                if not part: raise EOFError()
                result+=part
            return result
        size=struct.unpack("!I",read(4))[0]
        assert 0<size<=8192
        answer=json.loads(read(size))
        assert connection.recv(1)==b""
    except (OSError,EOFError):
        pass
    finally:
        connection.close()
    # There is exactly one connection/request. Reap even if the manager refuses
    # before registering the child or its reply is lost after SIGCONT.
    waiter.join(.3)
    if waiter.is_alive(): child.kill()
    waiter.join(2)
    assert not waiter.is_alive()
    print(json.dumps({"answer":answer,"broker":broker,"reaped":not Path(f"/proc/{child.pid}").exists()}),flush=True)
finally:
    if child is not None:
        if child.poll() is None: child.kill()
        child.wait(2)
    if waiter is not None: waiter.join(2)
'''


def exchange(endpoint, entry, request, frame_delay):
    config = {"endpoint": str(endpoint), "entry": str(entry), "request": request,
              "frame_delay": frame_delay, "ownership": str(entry.parent.parent / "owned-broker.json")}
    source = SERVER.replace("CONFIG", repr(config), 1)
    compile(source, "<synthetic manager peer>", "exec")
    # Exactly one executable argv is essential to the real ServerPeer check.
    child = subprocess.Popen([str(Path("/usr/bin/python3").resolve())],
        env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        child.stdin.write(source)
        child.stdin.close()
        child.stdin = None
        if not select.select([child.stdout], [], [], 3)[0]:
            raise TimeoutError("synthetic peer connection")
        assert json.loads(child.stdout.readline()) == {"connected": True}
        return child
    except BaseException:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(3)
        for stream in (child.stdin, child.stdout, child.stderr):
            if stream is not None:
                stream.close()
        raise
