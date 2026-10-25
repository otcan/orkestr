"""Exact-run model evidence for reply footers; never infer an answering model."""
import re
import uuid


def token(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", value) else None


def observed_identity(call, run_id=None, status=None, fast=False):
    if run_id is not None:
        valid_run = False
        try:
            valid_run = isinstance(run_id, str) and str(uuid.UUID(run_id)) == run_id and uuid.UUID(run_id).int != 0
        except ValueError:
            pass
        if status is None and valid_run:
            try:
                status = call("GET", ("/fast/execution" if fast else "/execution") + "?run_id=" + run_id)
            except Exception:
                status = None
        if not valid_run or not isinstance(status, dict) or status.get("run_id") != run_id:
            status = None
    if run_id is None:
        status = None
    models = status.get("models") if isinstance(status, dict) else None
    models = models if isinstance(models, dict) else {}
    provider = token(models.get("provider"))
    model = token(models.get("actual_model"))
    failure = status.get("failure") if isinstance(status, dict) else None
    if isinstance(failure, dict) and failure.get("class") == "policy":
        model = token(models.get("refused_model")) or token(models.get("resolved_model"))
    # Legacy status or operational posts may have no run evidence. Their
    # configured/declarative model is deliberately not reported as an answer.
    result = {"model": model or "unreported"}
    if isinstance(status, dict) and run_id is not None and status.get("run_id") == run_id:
        result.update(identitySource="run", runId=run_id, layer="fast" if fast else "deep")
        # Current Core may omit actual effort. Never fill it from preferences.
        effort = models.get("actual_reasoning_effort")
        if effort in ("low", "medium", "high", "xhigh", "max", "ultra"):
            result["observedReasoningEffort"] = effort
    if provider:
        result["provider"] = provider
    return result
