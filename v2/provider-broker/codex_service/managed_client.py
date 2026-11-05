"""Unprivileged managed CLI transport. Reads one bounded request on stdin.

No credential, role or conversation argument. Root derives those from the
actual kernel sender and original managed launch. This helper never uses sudo.
"""
import json
from pathlib import Path
import socket
import stat
import struct
import sys

MAX_PACKET=16384


def require(value):
    if not value:raise RuntimeError('managed transport refused')


def unique(items):
    result={}
    for key,value in items:
        require(key not in result);result[key]=value
    return result


def endpoint(path):
    require(path.is_absolute() and path.resolve(strict=True)==path and len(bytes(path))<100)
    for parent in path.parents:
        info=parent.lstat();require(info.st_uid==0 and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode))
    info=path.lstat();require(stat.S_ISSOCK(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o660)
    return info.st_dev,info.st_ino


def exchange(path,raw):
    require(type(raw) is bytes and 0<len(raw)<=MAX_PACKET)
    request=json.loads(raw.decode('utf-8','strict'),object_pairs_hook=unique)
    require(type(request) is dict and set(request)=={'version','request_key','operation','arguments'} and
            type(request['version']) is int and request['version']==1 and type(request['request_key']) is str)
    identity=endpoint(path)
    with socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET) as connection:
        connection.settimeout(40);connection.connect(str(path))
        pid,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        require(uid==0 and pid>1 and endpoint(path)==identity)
        require(connection.send(raw)==len(raw))
        reply,ancillary,flags,_=connection.recvmsg(MAX_PACKET+1,0)
        require(not ancillary and not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) and 0<len(reply)<=MAX_PACKET)
    value=json.loads(reply.decode('utf-8','strict'),object_pairs_hook=unique)
    require(type(value) is dict and set(value)=={'version','request_key','request_id','state','result'} and
            type(value['version']) is int and value['version']==1 and value['request_key']==request['request_key'] and
            value['state'] in ('completed','unknown','cancelled'))
    return value


def main():
    require(len(sys.argv)==2 and sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode)
    require(any(line.startswith('NoNewPrivs:') and line.split()[1]=='1'
                for line in Path('/proc/self/status').read_text().splitlines()))
    raw=sys.stdin.buffer.read(MAX_PACKET+1)
    value=exchange(Path(sys.argv[1]),raw)
    sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n')
    return 0 if value['state']=='completed' else 2


if __name__=='__main__':
    try:sys.exit(main())
    except Exception:
        # Never print provider text, paths, request bodies or credentials.
        sys.stderr.write('managed transport outcome unknown; do not replay\n');sys.exit(2)
