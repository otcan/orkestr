"""Bounded worker ownership/FIFO; one accept-loop owner calls submit/poll."""
from collections import deque
import threading
import time

if __package__:
    from .bounded_budget import Budget, Context, Refused, CleanupIncomplete
    from .bounded_io import read_prelude, peer_closed
else:
    from bounded_budget import Budget, Context, Refused, CleanupIncomplete
    from bounded_io import read_prelude, peer_closed


class Pool:
    def __init__(self, serve, budget=None, outer=False):
        self.serve = serve
        self.budget = budget if budget is not None else Budget()
        self.outer = outer
        self.active = []
        self.pending = deque()
        self.peak_active = self.peak_pending = 0
        self.refused = 0
        self.closed = False
        self.cleanup_failed = False

    def submit(self, context):
        """Only authenticated outer peers may reach this method.

        Count before header/destination work. The inner must have opened its
        retained authenticated root channel even when this local pool refuses.
        """
        try:
            self.budget.attempt()
            self.poll()  # f5a post-accept accounting: reap before capacity check.
            if self.closed:
                raise Refused("cancelled")
            if len(self.active) < self.budget.limits.active:
                self._start(context)
            elif len(self.pending) < self.budget.limits.pending:
                self.pending.append(context)
                self.peak_pending = max(self.peak_pending, len(self.pending))
            else:
                raise Refused("capacity")
            return True
        except Refused as error:
            self.refused += 1
            context.outcome = str(error)
            context.close()
            return False

    def poll(self):
        live = []
        for context, thread in self.active:
            if not thread.is_alive():
                thread.join()
            else:
                live.append((context, thread))
        self.active = live
        kept = deque()
        for context in self.pending:
            try:
                context.check()
                if peer_closed(context.client):
                    raise Refused("pending_peer_closed")
                if self.outer:
                    read_prelude(context, False)
                kept.append(context)
            except (Refused, OSError, ValueError):
                context.outcome = "pending_refused"
                context.close()
        self.pending = kept
        if self.budget.stopped.is_set():
            for context, _thread in self.active:
                context.close()
        while self.pending and len(self.active) < self.budget.limits.active:
            self._start(self.pending.popleft())

    def _start(self, context):
        def work():
            try:
                if self.outer:
                    while not read_prelude(context):
                        context.check()
                self.serve(context)
                context.outcome = "eof"
            except Refused as error:
                context.outcome = str(error)
            except CleanupIncomplete:
                self.cleanup_failed = True
                context.outcome = "cleanup_incomplete"
            except (OSError, ValueError, UnicodeError):
                context.outcome = "transport_refused"
            except Exception:
                context.outcome = "internal_refused"
            finally:
                context.close()
                context.done.set()
        thread = threading.Thread(target=work, name="bounded-proxy-relay")
        self.active.append((context, thread))
        self.peak_active = max(self.peak_active, len(self.active))
        try:
            thread.start()
        except RuntimeError:
            self.active.pop()
            context.close()
            raise Refused("worker_start") from None

    def close(self):
        self.budget.stop()
        self.retire()

    def retire(self):
        """Clean one endpoint epoch without refunding/stopping shared authority.

        Only the owning controller uses this during an explicitly controlled
        server replacement. It passes the same Budget to the successor Pool.
        """
        self.closed = True
        for context in self.pending:
            context.close()
        self.pending.clear()
        for context, _thread in self.active:
            context.close()
        # One overall cleanup bound, not a fresh bound for each worker.
        deadline = time.monotonic() + 3
        for _context, thread in self.active:
            thread.join(max(0, deadline - time.monotonic()))
        if self.cleanup_failed or any(thread.is_alive() for _context, thread in self.active):
            raise RuntimeError("bounded proxy cleanup incomplete")
        self.active.clear()
