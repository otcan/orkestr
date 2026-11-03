"""The owner-facing cause of an ended Deep run, from Core's closed run status.

Core reports a failed run's closed provider class (`failure.class`), never
provider text. Codex capacity (an at-capacity or overloaded model that the
capacity fallback could not retry, logged by Runtime as
`orkestr_capacity_fallback ... outcome=not_retried_*`) is the only Codex
failure delivered with the `provider` class; Runtime's other Codex failures
carry no class. A future explicit `capacity` class is accepted as well.

Core shows the class only while the run reads `failed`; a run cancelled later
(e.g. by reconciliation) reads plain `cancelled`. The cause is therefore kept
on the input, for that exact run, from the first status read that showed it.
The notice says "stopped by a model-capacity error"; the raw reason code
(`deep_run_failed:provider`, `deep_run_cancelled`) stays in logs and the
export's `refusal` field only.

A run interrupted by a server restart (a crash or a deploy) reads plain
`cancelled`, `lost` or `interrupted` with no class. When the serving process
started after the run's window opened, the run cannot have survived that
start: the notice says "interrupted by an Orkestr server restart (back up at
HH:MM UTC)" instead of the bare code, so the owner knows why and that a resend
is safe to judge. Nothing is retried for it: the run may already have acted.
"""
import time

from . import notices

MODEL_CAPACITY = "model_capacity"
SERVER_RESTART = "server_restart"
RESTART_PHASES = ("cancelled", "lost", "interrupted")
KEY = "deep_failure_cause"


def is_capacity(status):
    if not isinstance(status, dict):
        return False
    failure = status.get("failure")
    kind = failure.get("class") if isinstance(failure, dict) else None
    models = status.get("models") if isinstance(status.get("models"), dict) else {}
    return kind == "capacity" or (kind == "provider" and models.get("provider") == "codex")


def note(data, status):
    """Record (or forget) the cause for this input's own ended Deep `status`."""
    run = status.get("run_id") if isinstance(status, dict) else None
    known = data.get(KEY) or {}
    if is_capacity(status):
        data[KEY] = {"cause": MODEL_CAPACITY, "run_id": run}
    elif known and known.get("run_id") != run:
        data.pop(KEY, None)  # Another run ended: its cause is unknown.


def note_restart(data, status, started_at_ms, opened_at_ms):
    """Record a server restart as the cause of this input's ended Deep `status`
    when the serving process started after the run's window opened. A known
    capacity cause of the same run is kept: it ended the run first."""
    run = status.get("run_id") if isinstance(status, dict) else None
    known = data.get(KEY) or {}
    if (run is None or status.get("phase") not in RESTART_PHASES or status.get("failure") or
            (known.get("cause") == MODEL_CAPACITY and known.get("run_id") == run)):
        return
    if type(started_at_ms) is not int or type(opened_at_ms) is not int or started_at_ms <= opened_at_ms:
        return
    data[KEY] = {"cause": SERVER_RESTART, "run_id": run, "at_ms": started_at_ms}


def cause(data, reason):
    """The recorded cause behind a `deep_run_*` refusal reason, else None."""
    known = data.get(KEY) or {}
    if isinstance(reason, str) and reason.startswith("deep_run_") and known.get("cause") in (MODEL_CAPACITY,
                                                                                          SERVER_RESTART):
        return known["cause"]
    return None


def owner_reason(data, reason, lang):
    """What a technical notice says in place of the raw reason code."""
    found = cause(data, reason)
    if found == MODEL_CAPACITY:
        return notices.render(lang, "reason_model_capacity")
    if found == SERVER_RESTART:
        at = time.strftime("%H:%M", time.gmtime((data.get(KEY) or {}).get("at_ms", 0) / 1000))
        return notices.render(lang, "reason_server_restart", at=at)
    return reason
