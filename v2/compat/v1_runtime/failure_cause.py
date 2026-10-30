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
"""
from . import notices

MODEL_CAPACITY = "model_capacity"
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


def cause(data, reason):
    """The recorded cause behind a `deep_run_*` refusal reason, else None."""
    known = data.get(KEY) or {}
    if isinstance(reason, str) and reason.startswith("deep_run_") and known.get("cause") == MODEL_CAPACITY:
        return MODEL_CAPACITY
    return None


def owner_reason(data, reason, lang):
    """What a technical notice says in place of the raw reason code."""
    return notices.render(lang, "reason_model_capacity") if cause(data, reason) else reason
