"""Trusted opt-in tool correlation; JSON is never a Core delivery capability."""
from protocol import require
from workspace_tool import validate_call, validate_submission


class WorkspaceRoute:
    def __init__(self):
        self.pending=None
        self.ids=set()
        self.calls=set()

    def receive(self,frame,native,turn):
        require(self.pending is None and len(self.ids)<128)
        clean=validate_call(frame,native,turn)
        key=(type(clean['id']),clean['id'])
        call=clean['params']['callId']
        require(key not in self.ids and call not in self.calls)
        self.ids.add(key);self.calls.add(call)
        self.pending=clean['id']
        return clean

    def submit(self,envelope,handle):
        require(self.pending is not None)
        clean=validate_submission(envelope,handle,self.pending)
        # Latch before preparation. Partial/unknown delivery cannot resubmit.
        self.pending=None
        return clean['params']['frame']

    def cancel(self):
        had_pending=self.pending is not None
        self.pending=None
        # Histories remain burned; cancellation never returns a result grant.
        return had_pending
