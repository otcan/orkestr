"""Bounded, value-free native stderr diagnostics. Never execution/reap proof."""
import json
import re

CAPTURE_BYTES = 8192
MAX_OBSERVED = (1 << 63) - 1
# Only fixed category labels escape. Provider text, paths, model/account names,
# addresses, tokens and arbitrary error messages are never returned or logged.
CATEGORIES = {
    "authentication": r"unauthori[sz]ed|authentication|invalid.{0,20}(token|credential)|not logged in|\b401\b",
    "permission": r"permission denied|access denied|\beacces\b|\b403\b",
    "rate_limit": r"rate.limit|too many requests|\b429\b",
    "session_missing": r"session.{0,40}(not found|does not exist|invalid)|no conversation found",
    "network": r"econnreset|econnrefused|enotfound|etimedout|network|connection.{0,20}(reset|closed|failed)",
    "argument": r"unknown (option|argument)|unrecognized (option|argument)|invalid (option|argument)",
    "resource": r"out of memory|\benomem\b|\benospc\b|too many open files|\bemfile\b",
    "protocol": r"invalid json|unexpected eof|protocol|malformed",
}


class StderrCapture:
    def __init__(self):
        self.tail = bytearray()
        self.observed = 0

    def feed(self, chunk):
        if not isinstance(chunk, bytes):
            return
        self.observed = min(MAX_OBSERVED, self.observed + len(chunk))
        # OS reads are bounded too; retain only the final 8KiB in memory.
        self.tail.extend(chunk[-CAPTURE_BYTES:])
        del self.tail[:-CAPTURE_BYTES]

    def summary(self):
        text = self.tail.decode('utf-8', 'replace').lower()
        classes = sorted(name for name, pattern in CATEGORIES.items() if re.search(pattern, text))
        return {"classes": classes or (["unclassified"] if self.observed else []),
                "observed_bytes": self.observed, "retained_bytes": len(self.tail),
                "truncated": self.observed > len(self.tail), "free_text_redacted": True}


def report_failure(pump, resumed, emit):
    """Optional operator diagnostic only; cannot change lifecycle or exit code."""
    try:
        code = pump.failure_exit
        if type(code) is not int or not 80 <= code <= 217:
            return
        channel = pump.channel
        phase = 'initialized' if getattr(channel, 'initialized', False) else (
            'initializing' if getattr(channel, 'setup', None) is not None else 'opening')
        value = {"event": "claude_broker_failure", "resumed": resumed is True,
                 "phase": phase, "failure_class": (code - 80) // 6 + 1,
                 "native_state": (code - 80) % 6, "broker_exit_code": code,
                 "last_provider_frame_bytes": pump.last_provider_frame_bytes,
                 "stderr": pump.stderr_capture.summary(), "diagnostic_only": True}
        emit(json.dumps(value, sort_keys=True, separators=(',', ':')))
    except Exception:
        pass  # Diagnostics never authorize a fallback or break cleanup.
