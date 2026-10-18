"""Server-private resume specification; lifecycle evidence is NOT Core authority.

Never deserialize this object from protocol JSON. Runtime must additionally own
an issued resume setup/attachment capability before launching a new broker.
"""
import uuid
from protocol import require

_SEAL = object()


class ResumeSpec:
    __slots__ = ("_config", "_native", "_used")

    def __init__(self, seal, config, native):
        require(seal is _SEAL)
        self._config, self._native, self._used = config, native, False

    def __reduce__(self):
        raise TypeError("resume specifications cannot be serialized")

    def __copy__(self):
        raise TypeError("resume specifications cannot be copied")

    def __deepcopy__(self, _memo):
        raise TypeError("resume specifications cannot be copied")

    def _take(self, config):
        require(not self._used and config is self._config)
        self._used = True  # no reissue after launch/configuration failure
        return self._native


def retire(session, channel, *, writer_closed, completion_accepted):
    """Trusted launcher hook, outside any SQLite callback; no kill or retry.

    completion_accepted is a server-private callback into Runtime's durable
    completion+owner-acceptance check for this exact session/terminal receipt.
    The callback must never be supplied by JSON. Its success grants no new turn.
    """
    require(channel.session is session and session._owned_child is not None)
    require(not session._retired and writer_closed is True)
    require(not channel.poisoned and channel.terminal and channel.active is not None)
    terminal = channel.terminal_uuid
    require(isinstance(terminal, str) and str(uuid.UUID(terminal)) == terminal)
    child = session._owned_child
    # poll() can reap; wait() is still required here to complete owned wait.
    require(child.poll() == 0 and child.stdin is None and child.stdout.closed)
    require(child.wait(timeout=0) == 0)
    session._retired = True  # failed durable acceptance permanently quarantines
    require(completion_accepted(session, channel.active, terminal) is True)
    return ResumeSpec(_SEAL, session._config, session.native)
