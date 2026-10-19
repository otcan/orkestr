#!/usr/bin/python3
"""Separate private Claude entry; no listener, fallback, account or argv input."""
from pathlib import Path
import signal
import socket
import sys
from claude_connector import ClaudeConfiguration
from claude_protocol import ClaudeChannel
from protocol import PROTOCOL, Refused
from claude_pump import ClaudePump
from reaping import REAPED_EXIT


def main(configuration_path=None, account_environment=None):
    arguments = sys.argv[1:]
    resumed = arguments == ["resume-owned-session", "--protocol", PROTOCOL]
    if not resumed and arguments != ["open-owned-session", "--protocol", PROTOCOL]:
        return 2
    def stop(_signal, _frame):
        raise Refused("owned Claude stopped")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        config = ClaudeConfiguration.load(configuration_path or
            Path(__file__).with_name("claude-private.json"))
        if resumed:
            from claude_bootstrap import receive
            specification = receive(config)
            session = config.resumed_session(specification, account_environment)
        else:
            session = config.new_session(account_environment)
        with socket.socket(fileno=3) as handoff:
            if handoff.family != socket.AF_UNIX or handoff.type != socket.SOCK_STREAM:
                raise Refused("invalid private handoff")
            handoff.getpeername()
            pump = ClaudePump(session, ClaudeChannel(session), handoff=handoff)
            pump.run()
            if pump.parent_eof and pump.child is not None and pump.reaped:
                return REAPED_EXIT
        return 0
    except Exception:
        sys.stderr.write("Claude broker refused; reconcile uncertain delivery\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
