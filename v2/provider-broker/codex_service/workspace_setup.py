"""Source-qualified project attestation; no command or provider dispatch.

Only Manager's kernel-authenticated original Core may request this transfer.
The supplied socket is another endpoint created by that same Core process.
Every response rechecks the originally retained directory identities and Git
association. Unknown delivery is a failed setup, never an execution receipt.
"""
import array
import hashlib
import os
import socket
import struct

from codex_bounded.trust import exists
from .contract import canonical, identifier, require
from .workspace_custody import Installation
from .workspace_environment import definition


class Projects:
    def __init__(self, package):
        require(os.geteuid() == 0 and package.identity_split, 'workspace_setup_root')
        self.package = package
        self.installations = {}
        self.profiles = {}
        profiles = ([package.beta['workspace_exec']] if 'workspace_exec' in package.beta else []) + \
            package.beta.get('additional_workspace_exec', [])
        require(len(profiles) <= 129, 'workspace_profile_bound')
        for profile in profiles:
            scope = (profile['conversation_id'], profile['project_id'])
            identifier(scope[0]); identifier(scope[1])
            require(scope not in self.profiles and type(profile.get('trusted')) is dict and
                    type(profile['trusted'].get('managed_executor')) is dict and
                    profile['trusted'].get('host_privileged', False) is False and
                    profile['trusted'].get('environment', {}) == {} and
                    profile['trusted'].get('credential_env_files', []) == [], 'workspace_explicit_profile')
            definition(profile['trusted']['managed_executor'])
            self.profiles[scope] = profile

    def attest(self, source, request, endpoint):
        require(exists(source) and source['uid'] == self.package.authority_uid, 'workspace_source_changed')
        require(request['owner_id'] == self.package.owner, 'workspace_owner_scope')
        scope = (request['conversation_id'], request['project_id'])
        require(scope in self.profiles, 'workspace_profile_scope')
        with socket.socket(fileno=os.dup(endpoint)) as channel:
            require(channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM,
                    'workspace_transfer_socket')
            pid, uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(pid == source['pid'] and uid == source['uid'] and exists(source), 'workspace_transfer_source')
            if scope not in self.installations:
                self.installations[scope] = Installation(self.package, self.profiles[scope])
            installation = self.installations[scope]; installation.check()
            value = {'format': 'orkestr-root-project-v1',
                     **{key: request[key] for key in ('request_id', 'owner_id', 'conversation_id', 'project_id')},
                     'paths': [str(path) for path in installation.paths],
                     'identities': [list(identity) for identity in installation.identities]}
            raw = canonical(value); require(len(raw) <= 16384, 'workspace_attestation_bound')
            packet = struct.pack('!I', len(raw)) + raw
            rights = array.array('i', installation.fds)
            channel.settimeout(.1)
            count = channel.sendmsg([packet], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)])
            require(0 < count <= len(packet), 'workspace_transfer_write')
            channel.sendall(packet[count:]); channel.shutdown(socket.SHUT_WR)
            return {'project_id': scope[1], 'attestation_sha256': hashlib.sha256(raw).hexdigest()}

    def close(self):
        for installation in self.installations.values(): installation.close()
        self.installations = {}
