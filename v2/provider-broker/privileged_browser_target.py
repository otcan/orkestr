"""Root-configured local browser instance proof, never an execution grant.

Only a protected operator descriptor selects targets. No registry, native input,
HTTP request, credential, browser command or process mutation is used here.
Call again immediately before sensitive browser operations; a changed instance
requires a new operator/broker descriptor rather than automatic retargeting.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
from urllib.parse import urlsplit

MAX_DESCRIPTOR = 65536
MAX_EXECUTABLE = 512 * 1024 * 1024
MAX_TCP_TABLE = 8 * 1024 * 1024


class Refused(ValueError):
    pass


def require(value, reason):
    if not value:
        raise Refused(reason)


def protected(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, 'target_descriptor_alias')
    for item in (path, *path.parents):
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode),
                'target_descriptor_custody')
        require(item == path or stat.S_ISDIR(info.st_mode), 'target_descriptor_ancestor')


def pairs(values):
    result = {}
    for key, value in values:
        require(key not in result, 'target_descriptor_duplicate_key')
        result[key] = value
    return result


def descriptor(path, slug):
    require(type(slug) is str and re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}', slug), 'target_slug')
    path = Path(path)
    protected(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                before.st_size <= MAX_DESCRIPTOR and before.st_uid == 0 and not before.st_mode & 0o022,
                'target_descriptor_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(MAX_DESCRIPTOR + 1)
        after = os.fstat(fd)
        identity = lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        require(identity(before) == identity(after) and len(raw) <= MAX_DESCRIPTOR, 'target_descriptor_changed')
        require((path.lstat().st_dev,path.lstat().st_ino)==(before.st_dev,before.st_ino), 'target_descriptor_changed')
        value = json.loads(raw, object_pairs_hook=pairs)
    finally:
        os.close(fd)
    protected(path)
    require(type(value) is dict and set(value)=={'schema_version','desk_targets'} and
            type(value['schema_version']) is int and value['schema_version']==1, 'target_descriptor_schema')
    targets=value['desk_targets']
    require(type(targets) is dict and 0<len(targets)<=64 and slug in targets, 'target_not_configured')
    target=targets[slug]
    fields={'endpoint','pid','start_ticks','uid','executable_sha256','listener_inode','net_namespace'}
    require(type(target) is dict and set(target)==fields, 'target_descriptor_shape')
    require(all(type(target[k]) is int and 0<=target[k]<2**63 for k in ['pid','start_ticks','uid']) and
            1<target['pid']<2**31 and target['start_ticks']>0 and target['uid']<2**32, 'target_process_identity')
    require(type(target['executable_sha256']) is str and re.fullmatch('[0-9a-f]{64}',target['executable_sha256']) and
            type(target['listener_inode']) is str and re.fullmatch('[1-9][0-9]{0,19}',target['listener_inode']) and
            type(target['net_namespace']) is str and re.fullmatch(r'net:\[[0-9]+\]',target['net_namespace']), 'target_kernel_identity')
    require(type(target['endpoint']) is str, 'target_endpoint')
    uri=urlsplit(target['endpoint'])
    try:port=uri.port
    except ValueError:raise Refused('target_endpoint') from None
    require(uri.scheme=='http' and uri.hostname=='127.0.0.1' and port and 1<=port<=65535 and
            target['endpoint']==f'http://127.0.0.1:{port}', 'target_endpoint')
    return target,port


def process_identity(root):
    raw=(root/'stat').read_text()
    fields=raw.rsplit(') ',1)[1].split()
    require(len(fields)>19 and fields[0] not in ('Z','X'), 'target_process_not_live')
    status=(root/'status').read_text()
    uid=next(line.split()[1:] for line in status.splitlines() if line.startswith('Uid:'))
    require(len(uid)==4 and len(set(uid))==1, 'target_process_uid')
    return int(fields[19]),int(uid[0]),os.readlink(root/'ns/net')


def executable_digest(root):
    executable=(root/'exe').resolve(strict=True)
    protected(executable)
    expected=executable.stat()
    fd=os.open(root/'exe',os.O_RDONLY|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        require((info.st_dev,info.st_ino)==(expected.st_dev,expected.st_ino), 'target_executable_namespace_mismatch')
        require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022 and
                info.st_size<=MAX_EXECUTABLE, 'target_executable_custody')
        checksum=hashlib.sha256()
        with os.fdopen(fd,'rb',closefd=False) as stream:
            count=0
            while chunk:=stream.read(65536):
                count+=len(chunk);require(count<=MAX_EXECUTABLE,'target_executable_bound');checksum.update(chunk)
        after=os.fstat(fd)
        require((info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==
                (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns), 'target_executable_changed')
        return checksum.hexdigest()
    finally:os.close(fd)


def owned_listener(root, inode, port):
    sockets=set()
    for index,fd in enumerate((root/'fd').iterdir()):
        require(index<4096,'target_descriptor_count')
        try:link=os.readlink(fd)
        except FileNotFoundError:continue
        if link.startswith('socket:[') and link.endswith(']'):sockets.add(link[8:-1])
    require(inode in sockets,'target_socket_not_owned')
    # IPv4 only: descriptor endpoint is exactly127.0.0.1, with no DNS lookup.
    with (root/'net/tcp').open('rb') as stream:raw=stream.read(MAX_TCP_TABLE+1)
    require(len(raw)<=MAX_TCP_TABLE,'target_socket_table_bound')
    address=f'0100007F:{port:04X}'
    require(any(len(fields:=line.split())>9 and fields[1]==address and fields[3]=='0A' and fields[9]==inode
                for line in raw.decode('ascii').splitlines()[1:]), 'target_listener_mismatch')


def connection(root, client_pid, local_port, port):
    require(type(client_pid) is int and client_pid==os.getppid() and
            type(local_port) is int and 1<=local_port<=65535, 'target_client_identity')
    client=Path('/proc',str(client_pid))
    client_before=process_identity(client)
    require(client_before[1]==0,'target_client_not_root')
    expected_local=f'0100007F:{local_port:04X}'
    expected_remote=f'0100007F:{port:04X}'
    def owned_inodes(proc):
        result=set()
        for index,fd in enumerate((proc/'fd').iterdir()):
            require(index<4096,'target_descriptor_count')
            try:link=os.readlink(fd)
            except FileNotFoundError:continue
            if link.startswith('socket:[') and link.endswith(']'):result.add(link[8:-1])
        return result
    def tcp(proc,local,remote):
        with (proc/'net/tcp').open('rb') as stream:raw=stream.read(MAX_TCP_TABLE+1)
        require(len(raw)<=MAX_TCP_TABLE,'target_socket_table_bound')
        owned=owned_inodes(proc)
        return [fields[9] for line in raw.decode('ascii').splitlines()[1:]
                if len(fields:=line.split())>9 and fields[1]==local and fields[2]==remote
                and fields[3]=='01' and fields[9] in owned]
    client_inodes=tcp(client,expected_local,expected_remote)
    server_inodes=tcp(root,expected_remote,expected_local)
    require(len(client_inodes)==len(server_inodes)==1,'target_connection_not_owned')
    require(process_identity(client)==client_before and
            client_inodes==tcp(client,expected_local,expected_remote) and
            server_inodes==tcp(root,expected_remote,expected_local), 'target_connection_changed')
    return {'client_pid':client_pid,'client_port':local_port,
            'client_inode':client_inodes[0],'server_inode':server_inodes[0]}


def verify(path, slug, client_pid=None, client_port=None):
    require(os.geteuid()==0 and hasattr(os,'pidfd_open'), 'target_root_kernel_proof_required')
    target,port=descriptor(path,slug)
    root=Path('/proc',str(target['pid']))
    pidfd=os.pidfd_open(target['pid'],0)
    try:
        poll=select.poll();poll.register(pidfd,select.POLLIN|select.POLLHUP|select.POLLERR)
        require(not poll.poll(0),'target_process_gone')
        expected=(target['start_ticks'],target['uid'],target['net_namespace'])
        require(process_identity(root)==expected,'target_process_changed')
        require(executable_digest(root)==target['executable_sha256'],'target_executable_changed')
        owned_listener(root,target['listener_inode'],port)
        connected=None
        if client_pid is not None or client_port is not None:
            connected=connection(root,client_pid,client_port,port)
        require(process_identity(root)==expected and not poll.poll(0),'target_process_changed')
        result={'desk':slug,'endpoint':target['endpoint'],'pid':target['pid'],
                'start_ticks':target['start_ticks'],'listener_inode':target['listener_inode']}
        if connected is not None:result['connection']=connected
        return result
    finally:os.close(pidfd)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--descriptor',required=True)
    parser.add_argument('--desk',required=True)
    parser.add_argument('--client-pid',type=int)
    parser.add_argument('--client-port',type=int)
    args=parser.parse_args()
    try:result=verify(args.descriptor,args.desk,args.client_pid,args.client_port)
    except (OSError,ValueError,StopIteration,IndexError):
        raise SystemExit('privileged browser target refused') from None
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__':main()
