"""Opt-in inner/root paths for the fixed bounded Codex acceptance role.

The new private-v2 prelude carries a same-host monotonic timestamp only. It does
not replace root peer/source authentication or the canonical CONNECT policy.
"""
import socket

if __package__:
    from .bounded_budget import Budget, Context, Refused
    from .bounded_io import PRELUDE, MAGIC, ESTABLISHED, connect, send, header, relay
    from .bounded_pool import Pool
    from . import bounded_dns
    from .supervisor import destination
else:
    from bounded_budget import Budget, Context, Refused
    from bounded_io import PRELUDE, MAGIC, ESTABLISHED, connect, send, header, relay
    from bounded_pool import Pool
    from supervisor import destination
    bounded_dns = None  # Only the authenticated outer controller resolves DNS.


class Inner:
    def __init__(self, hosts, endpoint="/run/provider-egress.sock", budget=None):
        self.hosts, self.endpoint = hosts, endpoint
        self.budget = budget if budget is not None else Budget()
        self.pool = Pool(self.serve, self.budget)

    def admit(self, client, accepted_ns=None):
        context = Context(client, self.budget, accepted_ns)
        try:
            # A retained local channel exists even for queued/refused attempts,
            # so the root's cross-native attempt counter sees this boundary.
            upstream = context.own(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
            connect(context, upstream, self.endpoint)
            send(context, upstream, PRELUDE.pack(MAGIC, context.accepted_ns))
            context.root_channel = upstream
            return self.pool.submit(context)
        except (Refused, OSError, ValueError):
            context.close()
            return False

    def serve(self, context):
        request = destination(header(context, context.client), self.hosts)
        send(context, context.root_channel, request)
        if header(context, context.root_channel) != ESTABLISHED:
            raise Refused("root_reply")
        send(context, context.client, ESTABLISHED)
        context.establish()
        relay(context, context.root_channel)

    def poll(self):
        self.pool.poll()

    def close(self):
        self.pool.close()


def outer(context, hosts, resolver=None, connector=None):
    """Use Pool(..., outer=True) only after fixed peer/source authentication.

    Tests may inject numeric resolution/connection functions; the installed
    private launcher supplies neither. A native request cannot select them.
    """
    if context.client.family != socket.AF_UNIX:
        raise Refused("private_endpoint")
    request = destination(header(context, context.client), hosts)
    host = request.split(b" ")[1].decode().removesuffix(":443")
    addresses = (bounded_dns.resolve(context, host) if resolver is None else resolver(context, host))
    family, kind, protocol, address = addresses[0]
    upstream = context.own(socket.socket(family, kind, protocol))
    if connector is None:
        connect(context, upstream, address)
    else:
        connector(context, upstream, address)
    send(context, context.client, ESTABLISHED)
    context.establish()
    relay(context, upstream)
