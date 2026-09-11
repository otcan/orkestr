# Codex Remote Compaction Recovery

Codex CLI versions and configurations that select the legacy
`codex/responses/compact` route can receive HTTP 404 after that route becomes
unavailable. Codex then terminates the active turn before producing a final
answer. This is an upstream compatibility failure, not evidence that the
Orkestr host, timer scheduler, or tenant VM stopped.

Orkestr starts its managed Codex app-server with `remote_compaction_v2`
enabled. New installs use Codex CLI 0.154.0 by default. Existing installations
should check and update their separately installed CLI:

```bash
codex --version
codex features list | rg '^remote_compaction_v2'
codex update
```

After updating, restart the managed Codex app-server through the normal
Orkestr service or release procedure. Do not edit another user's Codex config
or authentication files directly. OpenAI tracks the legacy-route behavior in
[openai/codex#42468](https://github.com/openai/codex/issues/42468).

## Recovery contract

When a failed turn identifies remote compaction plus upstream HTTP 404,
Orkestr records:

- failure class `codex_remote_compaction_404`;
- upstream status `404` and endpoint category `codex_responses_compact`;
- the Codex runtime generation and turn ID;
- recovery policy `safe_reset_once_no_automatic_turn_replay`.

Orkestr confirms that no live turn remains, checkpoints recent history, and
makes at most one automatic safe-reset attempt for that generation and turn.
The session reset creates a fresh Codex runtime; it does not replay the failed
input.

Timer turns are deliberately not replayed. A timer may have already sent a
message, changed a CRM record, or performed another external effect before
compaction failed. The thread history therefore shows an explicit manual retry
action. Review partial work first, then use **Retry timer** in the message or
run `orkestr timers run <timer-id>`. The normal timer run event is the durable
audit boundary for that operator-authorized retry.

Ordinary Codex failures and successful context compaction keep their existing
behavior.
