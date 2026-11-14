"""Windows whose cleanup was uncertain: operator release and refusal notices.

A window whose emergency cleanup was uncertain (its descendant walk failed,
for example on a child with another uid, and its tree was force-killed) is
never reconciled by the manager that holds it: `reconcile` refuses
`owned_cleanup_uncertain` for the rest of that manager's life. On 2026-11-10
(ORK-781) one such window blocked its conversation until the pilot restarted.

Operator release, without a restart: an operator who has checked the host
creates an empty root-owned file named `<window_id>.<generation>` in the
Root-only `operator-releases` directory of the manager's ledger directory
(for example `install -m 600 /dev/null <ledger>/operator-releases/<id>.<gen>`).
At its next tick the manager checks, fail-closed, that nothing of that window
can still run:

* this manager holds the window at that generation, its relay is closed, and
  the manager is not custody-faulted;
* every broker of the window was launched by this manager (identity split),
  so an orphan of its tree can only be re-parented to this subreaper;
* the descendant walk of whatever is still alive succeeds;
* every recorded identity of the window is gone, compared by pid and start
  time (any uid): a zombie or a reused pid does not pass;
* every identity the failed walk saw but could not record is gone the same way;
* the manager has no unassigned or undrained adopted child.

Only then does the window's custody count as released, and the server's next
reconcile attempt closes the window. Any failed check changes nothing. The
manager removes the request, writes `<window_id>.<generation>.receipt` (JSON:
outcome and closed reason code) and logs one line either way. Retirement, the
graceful path, still never accepts uncertain cleanup.

Automatic re-check (ORK-828): when the only cause of the uncertainty is a
descendant refused for its uid (`owned_child_identity`, typically a short-lived
setuid helper), the walk kept that descendant's pid and start time, so the
same proof covers everything the walk saw. `reconcile` then runs the proof
itself on every attempt instead of waiting for an operator file: on
2026-11-14 such a window blocked its conversation, and every release train,
for 38 minutes after its whole tree was gone. Every other uncertainty still
needs the operator request.
"""
import json
import os
import re
import sys
import time

from codex_bounded.trust import protected
from .contract import Refused, require
from .launch import atomic
from .ownership import same

DIRECTORY = 'operator-releases'
REQUEST = re.compile(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([1-9][0-9]{0,14})')
CHECK_S = 1.0
# Repeated identical refusals of one window log once per period.
NOTICE_PERIOD_S = 600
MAX_NOTICES = 256


def prove(manager, window_id, generation):
    """Release the custody hold of an uncertain window whose tree is gone.
    Raises Refused with a closed code when anything is not proven."""
    require(getattr(getattr(manager, 'package', None), 'identity_split', False) and getattr(manager, 'identity', None),
            'operator_release_unsupported')
    require(not getattr(manager, 'custody_fault', False), 'manager_custody_fault')
    window = manager.windows.get(window_id)
    require(window is not None and window.generation == generation, 'operator_release_window_unknown')
    require(window.egress_closed, 'window_egress_owned')
    children = window.children
    require(children.uncertain, 'operator_release_not_uncertain')  # Ordinary reconcile applies.
    with children.lock:
        require(children.brokers and children.brokers <= children.managed_brokers, 'operator_release_unmanaged_broker')
        require(not children.unrecorded_overflow, 'operator_release_unrecorded_overflow')
        try:
            children.observe()
        except Exception:
            raise Refused('operator_release_walk_failed') from None
        require(not any(same(record.identity, True) for record in children.records.values()),
                'owned_child_not_reaped')
        require(not any(same(identity, True) for identity in children.unrecorded.values()),
                'operator_release_unrecorded_alive')
    manager._capture_orphans()
    require(not manager.custody_fault, 'manager_custody_fault')
    adopted = getattr(manager, 'adopted', None)
    require(adopted is not None and not adopted.records, 'adopted_children_not_reaped')
    children.operator_released = True


# Uncertainty whose every unrecorded identity the walk kept (ownership.py
# `_unrecorded`), so `prove` alone settles it without an operator request.
AUTOMATIC_REASONS = frozenset(('owned_child_identity',))


def automatic(manager, window):
    """Reconcile's own fail-closed re-check of an uncertain window (see the
    module docstring). True when the window's custody is released, now or by
    an earlier proof; one ALERT line when this call releases it. Never raises:
    an unproven window keeps refusing exactly as before."""
    children = window.children
    if getattr(children, 'operator_released', False):
        return True
    if not getattr(children, 'uncertain', False) or \
            getattr(children, 'uncertainty_reason', None) not in AUTOMATIC_REASONS:
        return False
    try:
        prove(manager, window.window, window.generation)
    except Exception:
        return False
    try:
        sys.stderr.write('ALERT orkestr-v2-manager window_release_proven window=%s generation=%d reason=%s\n'
                         % (window.window, window.generation, children.uncertainty_reason))
        sys.stderr.flush()
    except (OSError, ValueError):
        pass  # A diagnostic sink never changes the proof.
    return True


def _directory(manager):
    path = manager.package.ledger_directory / DIRECTORY
    path.mkdir(mode=0o700, exist_ok=True)
    protected(path, True)
    require(path.stat().st_mode & 0o777 == 0o700, 'operator_release_custody')
    return path


def _receipt(directory, name, outcome, reason):
    atomic(directory / (name + '.receipt'), {'request': name, 'outcome': outcome, 'reason': reason,
                                             'at_ms': time.time_ns() // 1_000_000})


def release_requests(manager, now=None):
    """Act on waiting operator release requests; never raises."""
    if not getattr(getattr(manager, 'package', None), 'identity_split', False):
        return
    now = time.monotonic() if now is None else now
    if 0 <= now - getattr(manager, 'release_checked', -CHECK_S) < CHECK_S:
        return
    manager.release_checked = now
    try:
        directory = _directory(manager)
        names = sorted(entry.name for entry in os.scandir(directory)
                       if not entry.name.startswith('.') and not entry.name.endswith('.receipt'))
    except Exception as error:
        _line(manager, 'unavailable', '-', 0, type(error).__name__)
        return
    for name in names:
        match = REQUEST.fullmatch(name)
        window_id, generation = (match[1], int(match[2])) if match else (None, 0)
        try:
            require(match, 'operator_release_request_name')
            protected(directory / name)
            prove(manager, window_id, generation)
            outcome, reason = 'released', None
        except Refused as error:
            outcome, reason = 'refused', str(error)[:64]
        except Exception as error:
            outcome, reason = 'refused', 'operator_release_error_' + type(error).__name__
        try:
            _receipt(directory, name if match else 'invalid-request', outcome, reason)
            os.unlink(directory / name)
        except OSError:
            pass  # The request stays and is checked again; the log line still names it.
        _line(manager, outcome, window_id or '-', generation, reason)


def _line(manager, outcome, window_id, generation, reason):
    if getattr(manager, 'release_last_line', None) == (outcome, window_id, generation, reason):
        return  # A stuck request (undeletable) logs once.
    manager.release_last_line = (outcome, window_id, generation, reason)
    try:
        sys.stderr.write('ALERT orkestr-v2-manager operator_window_release window=%s generation=%d outcome=%s reason=%s\n'
                         % (window_id, generation, outcome, reason or '-'))
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def refusal_notice(manager, operation, request, error, now=None):
    """The `manager refused` line, once per window, operation and code per
    NOTICE_PERIOD_S; a later line counts the repeats it left out."""
    now = time.monotonic() if now is None else now
    code = str(error)[:64]
    window = request.get('window_id') if isinstance(request, dict) else None
    generation = request.get('generation') if isinstance(request, dict) else None
    notices = getattr(manager, 'refusal_notices', None)
    if notices is None:
        notices = manager.refusal_notices = {}
    key = (operation, code, window if isinstance(window, str) else None,
           generation if type(generation) is int else None)
    seen = notices.get(key)
    if seen is not None and 0 <= now - seen[0] < NOTICE_PERIOD_S:
        notices[key] = (seen[0], seen[1] + 1)
        return
    if len(notices) >= MAX_NOTICES:
        for old in [k for k, (at, _) in notices.items() if not 0 <= now - at < NOTICE_PERIOD_S]:
            del notices[old]
    notices[key] = (now, 0)
    repeated = ' repeated=%d' % seen[1] if seen is not None and seen[1] else ''
    try:
        sys.stderr.write('manager refused %s: %s%s\n' % (operation, code, repeated))
        sys.stderr.flush()
    except (OSError, ValueError):
        pass  # A diagnostic sink never changes the refusal answer.
