"""Root-provisioned Unix CONNECT endpoint; no listener/startup installed here.

The operator owns listening socket permissions and immutable exact hostname list.
Only a designated isolated trusted connector may reach it. No token/auth parsing,
HTTP plaintext forwarding, client-selected port, DNS fallback or private IP route.
"""
import ipaddress
import selectors
import socket
import time
from .supervisor import destination, MAX_BYTES
from .authenticated_budget import AUTHENTICATED


def public_addresses(host, resolver=socket.getaddrinfo):
    records=resolver(host,443,type=socket.SOCK_STREAM)
    addresses=[]
    if not records or len(records)>16:raise ValueError("egress DNS refused")
    for family,kind,protocol,_name,address in records:
        ip=ipaddress.ip_address(address[0])
        if family not in (socket.AF_INET,socket.AF_INET6) or kind!=socket.SOCK_STREAM or not ip.is_global:
            raise ValueError("egress address refused")
        addresses.append((family,kind,protocol,address))
    return addresses


def serve_connection(client, hosts):
    """One bounded accepted Unix connection; caller bounds worker concurrency."""
    upstream=None
    try:
        if client.family!=socket.AF_UNIX:raise ValueError("private endpoint required")
        client.settimeout(2);header=bytearray()
        while not header.endswith(b"\r\n\r\n"):
            chunk=client.recv(1)
            if not chunk:raise ValueError("truncated CONNECT")
            header.extend(chunk)
            if len(header)>4096:raise ValueError("egress header bound")
        canonical=destination(bytes(header),hosts)
        host=canonical.split(b" ")[1].decode().removesuffix(":443")
        # Resolve once, reject the entire answer if any nonpublic address occurs,
        # and connect the validated numeric sockaddr. No hostname re-resolution.
        family,kind,protocol,address=public_addresses(host)[0]
        upstream=socket.socket(family,kind,protocol)
        upstream.settimeout(2);upstream.connect(address)
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        client.setblocking(False);upstream.setblocking(False)
        deadline=time.monotonic()+AUTHENTICATED.tunnel_seconds;count=0
        with selectors.DefaultSelector() as selector:
            selector.register(client,selectors.EVENT_READ,upstream)
            selector.register(upstream,selectors.EVENT_READ,client)
            while time.monotonic()<deadline:
                for key,_ in selector.select(.05):
                    try:data=key.fileobj.recv(16384)
                    except BlockingIOError:continue
                    if not data:return
                    count+=len(data)
                    if count>MAX_BYTES:return
                    view=memoryview(data)
                    while view and time.monotonic()<deadline:
                        try:sent=key.data.send(view)
                        except BlockingIOError:
                            with selectors.DefaultSelector() as writable:
                                writable.register(key.data,selectors.EVENT_WRITE);writable.select(.05)
                            continue
                        if sent<=0:return
                        view=view[sent:]
                    if view:return
    except (OSError,ValueError,UnicodeError):
        pass
    finally:
        client.close()
        if upstream is not None:upstream.close()
