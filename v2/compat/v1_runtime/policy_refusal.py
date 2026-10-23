"""A closed, exact-run policy failure becomes one honest owner notice."""
from .model_identity import token


def notice(status, own_runs):
    if (not isinstance(status, dict) or status.get("run_id") not in own_runs or
            status.get("phase") not in ("failed", "cancelled") or
            not isinstance(status.get("failure"), dict) or status["failure"].get("class") != "policy"):
        return None
    models = status.get("models")
    models = models if isinstance(models, dict) else {}
    model = token(models.get("refused_model")) or token(models.get("resolved_model")) or "unreported"
    provider = token(models.get("provider"))
    return {"text": "Provider policy refusal from %s. No fallback answer was accepted." %
                    (model if model != "unreported" else "an unreported model"),
            "model": model, **({"provider": provider} if provider else {})}
