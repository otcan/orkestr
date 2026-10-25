# Codex Fast model preferences

An owner can select a model and reasoning effort for a conversation's Codex Fast
role without changing Deep or Workers. This only selects next-turn parameters;
it does not admit an input, start a run, change the provider or reset native history.

`GET /api/v2/conversations/{id}/fast/settings` returns the current revision,
model and reasoning effort. Revision zero with null values means unchanged native
defaults. `PUT` fully replaces the Fast preference, using a separate optimistic
revision:

```json
{"expected_revision":0,"model":"gpt-6-luna","reasoning_effort":"low"}
```

A repeat with the same values and preceding revision is idempotent. Other stale
updates return `fast_settings_revision_mismatch`. Unknown fields and malformed or
policy-denied models are rejected. Existing owner authentication and browser CSRF
requirements apply; foreign conversations remain inaccessible.

The selection is frozen inside the Fast dispatch consumption transaction. A
running turn retains its original parameters. Deep and Worker launch settings,
conversation settings revisions and provider generations remain unchanged.
Unconfigured conversations keep the previous Fast behavior. Both values null
clear the override. Codex-specific preferences cannot be set for a Claude
conversation; if its provider later changes to Claude, stored Codex Fast
preferences do not apply. Availability and actual model latency depend on the
configured Codex account and must be verified separately.
