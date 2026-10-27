"""Protected dummy-only service package; no production/account/provider access."""
import json
import os
from pathlib import Path
import subprocess

from codex_bounded.configuration import BROKER, ISOLATION, MODULES
from codex_bounded.trust import digest
from codex_service.package import FILES, MODULES_SERVICE, SERVICE_BROKER, DEPENDENCIES, Package
from selected_codex_fixture import Fixture, UID, GID, packager, ROOT


class ServiceFixture(Fixture):
    def __init__(self):
        # Hosted runners may delegate /opt to their unprivileged runner user.
        # This explicit-root fixture owns its entire ancestry below /; never
        # chmod a shared host directory or relax production package validation.
        super().__init__(fixture_parent="/")
        self.package = self.root / "service-package"
        self.endpoint = self.root / "service-endpoint"
        self.ledger_directory = self.root / "service-ledger"
        for directory in (self.package, self.endpoint, self.ledger_directory):
            directory.mkdir(mode=0o750)
            os.chown(directory, 0, GID)
        self.ledger_directory.chmod(0o700)
        self.owner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    def prepare(self):
        root = self.package
        source = ROOT / "v2/provider-broker"
        for directory, names in (("broker", BROKER), ("isolation", ISOLATION),
                                  ("codex_bounded", MODULES), ("codex_service", MODULES_SERVICE),
                                  ("broker", SERVICE_BROKER)):
            if not (root / directory).exists():
                (root / directory).mkdir(mode=0o750)
                os.chown(root / directory, 0, GID)
            for name in names:
                selected = source / ("" if directory == "broker" else directory) / name
                packager.write(root / directory / name, selected.read_bytes(), GID,
                               0o550 if name == "supervisor.py" else 0o440)
        self._server()
        packager.write(root / "native", self.server.read_bytes(), GID, 0o550)
        interpreter = Path("/usr/bin/python3").resolve()
        for name, mode in (("launcher.py", "broker"), ("manager.py", "manager")):
            script = f'#!/bin/sh\nexec {interpreter} -I -S -B "$(dirname -- "$0")/codex_service/entry.py" {mode} "$@"\n'
            packager.write(root / name, script.encode(), GID, 0o550)
        service = {"format": "orkestr-v2-codex-service-v1", "uid": UID, "gid": GID,
                   "owner_id": self.owner, "conversation_id": self.plan["conversation_id"],
                   "home": str(self.home), "bootstrap_file": str(self.bootstrap),
                   "ledger_directory": str(self.ledger_directory), "endpoint_directory": str(self.endpoint),
                   "port": self.plan["port"], "trusted_origin": f"http://127.0.0.1:{self.plan['port']}"}
        beta = {"schema_version": 1, "owner_id": self.owner,
                "conversation_id": self.plan["conversation_id"], "manager_socket": str(self.endpoint / "control.sock"),
                "launcher": str(root / "launcher.py"), "launcher_sha256": digest(root / "launcher.py"),
                "workspace": str(self.workspace), "namespace": "synthetic-beta", "supervisor_key": "synthetic"}
        profile = {"format": "orkestr-v2-codex-isolated-v2", "native": str(root / "native"),
                   "auth_file": str(self.auth), "state_root": str(self.account), "workspace": str(self.workspace),
                   "egress_socket": str(self.endpoint / "egress.sock"),
                   "supervisor": str(root / "isolation/supervisor.py"), "hosts": ["chatgpt.com"]}
        for name, value in (("service.json", service), ("beta.json", beta), ("profile.json", profile)):
            packager.write(root / name, packager.encoded(value), GID)
        (root / "ui").mkdir(mode=0o750)
        os.chown(root / "ui", 0, GID)
        packager.write(root / "ui/index.html", b"<!doctype html><title>Synthetic fixture</title>", GID)
        manifest = {"format": "orkestr-v2-codex-service-package-v1", "source_commit": self.source,
                    "files": {name: digest(root / name) for name in sorted(FILES)},
                    "ui": {"index.html": digest(root / "ui/index.html")},
                    "dependencies": {str(Path(name).resolve()): digest(Path(name).resolve()) for name in DEPENDENCIES}}
        packager.write(root / "manifest.json", packager.encoded(manifest), GID)
        self.receipt = {"package": str(root), "manifest_sha256": digest(root / "manifest.json")}
        Package(root, self.receipt["manifest_sha256"])
        return self.receipt

    def _server(self):
        # Fixed synthetic ELF demonstrates actual UID/argv/SO_PEERCRED and
        # manager lifecycle; it is not represented as ordinary Rust execution.
        code = r'''
#include <arpa/inet.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
static volatile sig_atomic_t stopped;
static void stop(int n) {(void)n; stopped=1;}
int main(void) {
 signal(SIGINT,stop); signal(SIGTERM,stop); alarm(20);
 int fd=socket(AF_UNIX,SOCK_STREAM,0); struct sockaddr_un address={.sun_family=AF_UNIX};
 strcpy(address.sun_path, ENDPOINT);
 if(connect(fd,(struct sockaddr *)&address,sizeof(address))) return 3;
 const char request[]=REQUEST; unsigned size=htonl(sizeof(request)-1);
 if(write(fd,&size,4)!=4 || write(fd,request,sizeof(request)-1)!=(ssize_t)sizeof(request)-1) return 4;
 char response[8192]={0}; unsigned length=0;
 if(recv(fd,&length,4,MSG_WAITALL)!=4 || ntohl(length)>=sizeof(response)) return 5;
 if(recv(fd,response,ntohl(length),MSG_WAITALL)!=(ssize_t)ntohl(length)) return 6;
 close(fd); char target[4096]; snprintf(target,sizeof(target),"%s/synthetic-peer.json",getenv("ORKESTR_V2_HOME"));
 FILE *out=fopen(target,"w"); if(!out) return 7; fputs(response,out); fclose(out);
 while(!stopped) pause(); return 0;
}
'''
        request = {"version": 1, "operation": "status", "request_id": "synthetic-status",
                   "owner_id": self.owner, "conversation_id": self.plan["conversation_id"]}
        code = code.replace("ENDPOINT", json.dumps(str(self.endpoint / "control.sock")))
        code = code.replace("REQUEST", json.dumps(json.dumps(request)))
        subprocess.run(["cc", "-x", "c", "-", "-o", str(self.package / "server")],
            input=code.encode(), check=True, env={"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=10)
        os.chown(self.package / "server", 0, GID)
        (self.package / "server").chmod(0o550)
