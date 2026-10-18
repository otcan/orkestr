#!/usr/bin/python3
"""Dedicated trusted connector entry; no listener or client config flags."""
import signal
import socket
import sys
from pathlib import Path
from configuration import Configuration
from protocol import Channel, PROTOCOL, Refused
from transport import Pump


def main(configuration_path=None):
    resumed = sys.argv[1:] == ["resume-owned-session", "--protocol", PROTOCOL]
    if not resumed and sys.argv[1:] != ["open-owned-session", "--protocol", PROTOCOL]:
        return 2
    # An installer may generate a tiny trusted wrapper invoking main(privatepath).
    # The public executable defaults to a sibling SERVER-PRIVATE configuration.
    # Neither the client protocol nor an inherited environment chooses this file.
    path = configuration_path or Path(__file__).with_name("broker-private.json")
    def stop(_signal, _frame):
        raise Refused("owned broker stopped")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        config = Configuration.load(path)
        expected_native = None
        if resumed:
            from codex_bootstrap import receive
            expected_native = receive()
        # Launcher exclusively passes a private connected Unix socket at fd 3.
        # No path/listener, environment selector or legacy write fallback.
        with socket.socket(fileno=3) as handoff:
            if handoff.family != socket.AF_UNIX or handoff.type != socket.SOCK_STREAM:
                raise Refused("invalid private handoff")
            handoff.getpeername()
            Pump(config, Channel(config.workspace, expected_native=expected_native), handoff=handoff).run()
        return 0
    except Exception:
        # Never print provider output, private paths, account data or tokens.
        sys.stderr.write("provider broker refused; reconcile uncertain delivery\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
