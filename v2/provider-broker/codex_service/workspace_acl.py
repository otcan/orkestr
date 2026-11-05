"""Root-selected project owner and exact named-executor POSIX ACL custody.

The kernel validates these Linux xattrs when installed. Reading the retained
FD avoids path aliases. An ACL mask is not itself a grant to the owning group:
all effective writer entries must name only Root, the owner or the executor.
"""
import errno
import os
import grp
import pwd
import struct

from .contract import require


def owner(profile, executor):
    value=profile.get('project_owner_uid',executor)
    require(type(value) is int and 0<value<2**31,'workspace_project_owner_uid')
    return value


def source_group(gid, selected_writers):
    """Resolve every current NSS member; an unknown/unselected writer is fatal.

    Used only for Root traversal of sealed native source ancestry. This grants
    no directory access and never authorizes a Worker or a projected leaf.
    """
    require(selected_writers, 'workspace_unselected_group_writer')
    try:
        group=grp.getgrgid(gid)
        members={pwd.getpwnam(name).pw_uid for name in group.gr_mem}
        members.update(row.pw_uid for row in pwd.getpwall() if row.pw_gid==gid)
    except (KeyError,OSError):
        require(False,'workspace_source_group_unknown')
    require(members and members <= {0,*selected_writers}, 'workspace_unselected_group_writer')


def check(fd, project_owner, executor, permissions, owner_leaf=False, executor_gid=None, selected_writers=(), source_ancestry=False):
    if executor_gid is None:executor_gid=executor
    require(type(selected_writers) in (tuple,list,set,frozenset) and len(selected_writers)<=9
            and all(type(uid) is int and 0<uid<2**31 for uid in selected_writers), 'workspace_selected_writers')
    require(type(source_ancestry) is bool and (not source_ancestry or
            os.geteuid()==0 and permissions==0 and not owner_leaf and selected_writers),
            'workspace_source_ancestry')
    writers={0,project_owner,executor,*selected_writers}
    meta=os.fstat(fd)
    require(meta.st_uid in (0,project_owner) and meta.st_mode&0o002==0,
            'workspace_managed_custody')
    if owner_leaf:require(meta.st_uid==project_owner,'workspace_managed_owner')
    separate=executor!=project_owner and meta.st_uid==project_owner
    try:raw=os.getxattr(fd,'system.posix_acl_access')
    except OSError as error:
        if error.errno not in (errno.ENODATA,errno.ENOTSUP):raise
        raw=None
    if permissions==0 and raw is None:
        if source_ancestry and meta.st_mode&0o020:
            source_group(meta.st_gid,selected_writers)
        else:require(meta.st_mode&0o022==0,'workspace_managed_custody')
        return  # Root needs custody, not executor traversal of private ancestors.
    if not separate:
        require(meta.st_mode&0o022==0 or source_ancestry,'workspace_managed_custody')
        # No unadvertised ACL writer may hide behind a restrictive mask now
        # and become writable after a subsequent chmod/mask change.
        if raw is None:
            bits=(meta.st_mode>>6)&7 if meta.st_uid==executor else (meta.st_mode>>3)&7 if meta.st_gid==executor_gid else meta.st_mode&7
            require(bits&permissions==permissions,'workspace_executor_access')
            return
    require(raw is not None and len(raw)>=4 and (len(raw)-4)%8==0 and
            struct.unpack_from('<I',raw)[0]==2,'workspace_named_executor_acl')
    entries=[struct.unpack_from('<HHI',raw,offset) for offset in range(4,len(raw),8)]
    require(len(entries)<=1024 and all(bits<=7 for _,bits,_ in entries),'workspace_named_executor_acl')
    mask=[bits for tag,bits,_ in entries if tag==0x10]
    require(len(mask)==1,'workspace_named_executor_acl')
    named=[bits&mask[0] for tag,bits,uid in entries if tag==2 and uid==executor]
    if separate and permissions:require(len(named)==1 and named[0]&permissions==permissions,'workspace_named_executor_access')
    if meta.st_uid==executor:effective=(meta.st_mode>>6)&7
    elif named:effective=named[0]
    else:
        groups=[bits for tag,bits,gid in entries if tag==8 and gid==executor_gid or tag==4 and meta.st_gid==executor_gid]
        effective=0
        for bits in groups:effective|=bits
        effective=effective&mask[0] if groups else meta.st_mode&7
    require(effective&permissions==permissions,'workspace_executor_access')
    for tag,bits,uid in entries:
        require(tag in (1,2,4,8,0x10,0x20),'workspace_named_executor_acl')
        if source_ancestry and tag in (4,8) and bits&2:
            source_group(meta.st_gid if tag==4 else uid,selected_writers)
        elif tag in (4,8,0x20) or tag==2 and uid not in writers:
            require(bits&2==0,'workspace_unselected_acl_writer')
