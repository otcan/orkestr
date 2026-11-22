"""Admission of managed calls: concurrency and pace, with a large backstop.

History. The managed surface began (2026-11-05) as an inert observer for desk
logins and Root submissions, a few calls per turn. Every window then had a
lifetime bound of 32 claims and every native one of 128 HTTP requests, so that
one caller could not fill the Root-private claim journal. Native Worker calls
and Root host.exec requests later went through the same claims, and a busy
chat reached 32 within an hour of one window (windows extend up to 4 h while
working). From then on every call failed, and the refusal closed the
connection without an answer, so the chat saw only a transport error.

The bounds now protect what is actually shared:

* in flight: claims of one window whose caller still waits. They hold the
  manager's connection slots (`MAX_CONNECTIONS`, shared by all windows) and
  Core serves them one at a time;
* pace: a token bucket of new claims per window and of HTTP requests per
  original native. A refusal names the seconds until the next token;
* backstop: claims one window keeps in the journal. The journal keeps every
  claim of a held window (idempotence and the negative-stop proof read it), so
  this bounds its size. A refusal here lasts until the window closes.

Each refusal is answered (`Busy.refusal`) and reported on stderr; it never
creates a claim. Nothing here grants or executes an operation.
"""
import math
import re
import sys
import time

from .contract import Refused, require

# A chat may run 16 short calls in parallel; the burst lets three such waves
# pass back to back, and a native's HTTP burst stays above the claim burst so
# that the window's limit, not the transport's, is the one a chat meets.
DEFAULTS = {
    'window_in_flight_max': 16,
    'window_requests_per_minute': 120,
    'window_request_burst': 48,
    'window_requests_max': 2000,
    'native_http_requests_per_minute': 240,
    'native_http_request_burst': 96,
}
# Inclusive operator bounds: a deployment may tune a limit, never remove it.
RANGES = {
    'window_in_flight_max': (1, 32),  # The manager's connection slots for all windows.
    'window_requests_per_minute': (1, 600),
    'window_request_burst': (1, 600),
    'window_requests_max': (32, 10000),  # The old bound up to the negative-stop journal bound.
    'native_http_requests_per_minute': (1, 3600),
    'native_http_request_burst': (1, 3600),
}
# A slot frees when another call of the window finishes, typically in seconds.
IN_FLIGHT_RETRY_S = 2
REPORT_EVERY_S = 60
REASON = re.compile('[a-z][a-z0-9_]{0,63}')
MESSAGES = {
    'managed_window_busy': 'Root did not run this call: this execution window is at its managed-call limit. '
                           'Nothing was executed. Retry once after retry_after_s seconds.',
    'managed_native_busy': 'Root did not run this call: this agent sent managed requests faster than its limit. '
                           'Nothing was executed. Retry once after retry_after_s seconds.',
    'managed_window_budget_exhausted': 'Root did not run this call: this execution window has used its managed-call '
                                       'budget. Nothing was executed. Do not retry in this turn; tell the owner. '
                                       'A later execution window starts a new budget.',
}
# Argument-bound refusals (managed_ingress.packet): fixed texts that say which bound the call broke, so an
# agent does not read a size check as a permission decision (EasyLab, 2026-11-22: an 84-path host.exec
# summary of about 6.7 KB came back as "Root refused this call" and the chat gave up the cleanup).
ARGUMENT_MESSAGES = {
    'managed_submit_text': 'Root did not run this call: action, resource and summary must each be non-empty text '
                           'without NUL characters, at most 256, 512 and 4096 bytes (UTF-8). Nothing was executed. '
                           'This is a size check, not a permission or policy decision: split the work into '
                           'several smaller calls, or put long text in a file and pass its path.',
    'managed_submit_fields': 'Root did not run this call: send exactly the fields action, resource and summary. '
                             'Nothing was executed. This is a format check, not a permission or policy decision.',
}
STATE_MESSAGES = {
    'refused': 'Root refused this call before running it. Nothing was executed. Do not retry it unchanged.',
    'unknown': 'Root could not complete this call. Its outcome is unknown; do not repeat it automatically.',
    'cancelled': 'This call was cancelled before it completed.',
}


def limits(value=None):
    """The defaults, updated by a closed operator selection (`managed_limits`)."""
    value = {} if value is None else value
    require(type(value) is dict and set(value) <= set(DEFAULTS), 'managed_limits_configuration')
    for name, number in value.items():
        low, high = RANGES[name]
        require(type(number) is int and low <= number <= high, 'managed_limits_configuration')
    return {**DEFAULTS, **value}


class Busy(Refused):
    """A budget refusal: no claim exists and nothing ran."""

    def __init__(self, reason, limit, status, retry_after_s=None):
        super().__init__(reason)
        self.refusal = {'kind': 'managed_refusal', 'reason': reason, 'limit': limit, 'status': status,
                        'retryable': retry_after_s is not None, 'retry_after_s': retry_after_s,
                        'message': MESSAGES[reason]}


def refusal(error, state):
    """The fixed answer for a call Root did not complete. Never carries a result.

    `state` is the caller-visible outcome: `refused` (no claim, nothing ran),
    `unknown` or `cancelled`. Only fixed refusal categories leave the boundary.
    """
    if isinstance(error, Busy) and state == 'refused':
        return dict(error.refusal)
    reason = error.args[0] if isinstance(error, Refused) and error.args else None
    if type(reason) is not str or not REASON.fullmatch(reason):
        reason = 'managed_refused' if isinstance(error, Refused) else 'managed_internal_error'
    argument = state == 'refused' and reason in ARGUMENT_MESSAGES
    status = {'refused': 500 if reason == 'managed_internal_error' else 400 if argument else 403,
              'unknown': 504 if reason == 'managed_call_deadline' else 502, 'cancelled': 410}[state]
    return {'kind': 'managed_refusal', 'reason': reason, 'limit': None, 'status': status,
            'retryable': False, 'retry_after_s': None,
            'message': ARGUMENT_MESSAGES[reason] if argument else STATE_MESSAGES[state]}


class Bucket:
    """Token bucket on the monotonic clock."""

    def __init__(self, per_minute, burst, now):
        self.rate, self.burst, self.tokens, self.at = per_minute / 60.0, burst, float(burst), now

    def take(self, now):
        """Take one token; otherwise return the seconds until one is available."""
        if now > self.at:
            self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
            self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return 0
        return max(1, math.ceil((1 - self.tokens) / self.rate))


class Admission:
    """In-memory admission state. A restarted manager starts with full buckets;
    the backstop counts the durable journal, which survives restarts."""

    def __init__(self, value, stream=None):
        self.limits = value
        self.windows = {}  # window_id -> Bucket of new claims
        self.reports = {}  # (window_id, reason) -> [last report (monotonic), refusals since]
        self.stream = stream

    def admit(self, window, in_flight, claims, now=None):
        """Charge one new claim of `window`, or raise Busy. A refused claim
        takes no token; the backstop is checked first because it lasts."""
        now = time.monotonic() if now is None else now
        if claims >= self.limits['window_requests_max']:
            raise Busy('managed_window_budget_exhausted', 'window_requests_max', 409)
        if in_flight >= self.limits['window_in_flight_max']:
            raise Busy('managed_window_busy', 'window_in_flight_max', 429, IN_FLIGHT_RETRY_S)
        bucket = self.windows.get(window)
        if bucket is None:
            bucket = Bucket(self.limits['window_requests_per_minute'], self.limits['window_request_burst'], now)
        wait = bucket.take(now)
        self.windows[window] = bucket
        if wait:
            raise Busy('managed_window_busy', 'window_requests_per_minute', 429, wait)

    def native(self, record, now=None):
        """Charge one HTTP request of an original native (its registry record,
        which ends with the native). Returns Busy instead of raising so the
        request can still be read and answered."""
        now = time.monotonic() if now is None else now
        bucket = record.get('http_bucket')
        if bucket is None:
            bucket = record['http_bucket'] = Bucket(self.limits['native_http_requests_per_minute'],
                                                    self.limits['native_http_request_burst'], now)
        wait = bucket.take(now)
        return Busy('managed_native_busy', 'native_http_requests_per_minute', 429, wait) if wait else None

    def prune(self, held):
        for window in [w for w in self.windows if w not in held]:
            del self.windows[window]
        for key in [k for k in self.reports if k[0] not in held]:
            del self.reports[key]

    def report(self, source, operation, state, answer, now=None):
        """One operator line per window and reason a minute, with the number of
        refusals it stands for. A lasting budget refusal is an ALERT. Never raises."""
        try:
            now = time.monotonic() if now is None else now
            window = source.get('window_id') if type(source) is dict else None
            key = (window, answer['reason'])
            entry = self.reports.setdefault(key, [None, 0])
            entry[1] += 1
            if entry[0] is not None and now - entry[0] < REPORT_EVERY_S:
                return
            prefix = ('ALERT orkestr-v2-manager' if answer['status'] == 409 and state == 'refused'
                      else 'manager')
            line = ('%s managed_refusal reason=%s limit=%s status=%d state=%s window=%s generation=%s '
                    'operation=%s retry_after_s=%s refusals=%d\n'
                    % (prefix, answer['reason'], answer['limit'], answer['status'], state, window,
                       source.get('window_generation') if type(source) is dict else None,
                       operation if type(operation) is str and REASON.fullmatch(operation) else None,
                       answer['retry_after_s'], entry[1]))
            stream = self.stream or sys.stderr
            stream.write(line)
            stream.flush()
            entry[0], entry[1] = now, 0
        except Exception:
            pass
