"""Claude-only exact wire accounting; generic launch/reap/FD ownership unchanged."""
from protocol import decode
from transport import Pump


class ClaudePump(Pump):
    def line(self, fd, raw):
        if fd == self.incoming:
            return super().line(fd, raw)
        response = self.channel.provider(decode(raw), raw_size=len(raw) + 1)
        if response is not None:
            self.queue(self.outgoing, response)
