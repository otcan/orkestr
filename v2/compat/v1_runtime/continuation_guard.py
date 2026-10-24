"""Provider lineage for a deadline continuation; never select a fallback."""


def freeze(call, deep):
    # This field is read from the exact production run by Core. Never substitute
    # configured/default provider identity when old run evidence is absent.
    models = deep.get("models")
    provider = models.get("provider") if isinstance(models, dict) else None
    if provider not in ("codex", "claude"):
        raise ValueError("continuation_lineage_unknown")
    settings = call("GET", "/settings")
    if not isinstance(settings, dict) or settings.get("provider") != provider:
        raise ValueError("continuation_provider_changed")
    generation = settings.get("provider_generation")
    if type(generation) is not int or not 0 <= generation < 9007199254740992:
        raise ValueError("continuation_lineage_unknown")
    return {"provider": provider, "provider_generation": generation, "source_run_id": deep["run_id"]}


def generation(data):
    value = data.get("continuation_guard")
    if not isinstance(value, dict) or value.get("provider") not in ("codex", "claude"):
        raise ValueError("continuation_lineage_unknown")
    generation = value.get("provider_generation")
    if type(generation) is not int or not 0 <= generation < 9007199254740992:
        raise ValueError("continuation_lineage_unknown")
    if not isinstance(value.get("source_run_id"), str) or not value["source_run_id"]:
        raise ValueError("continuation_lineage_unknown")
    return generation
