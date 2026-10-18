# Runtime responsiveness

Agent execution, command waiting and message delivery are separate signals.
A live executor reporting ready takes precedence over historical input rows
still marked running. Their counts remain available for diagnosis, but do not
make the sidebar show Working. Pending inputs still show Queued.

Claude headless turns check external job status before waiting and use short
polling intervals. A Bash PreToolUse hook rejects literal shell sleeps longer
than 30 seconds with instructions to check progress again. It does not shorten
builds or tests, run commands, grant permissions, or terminate the turn.
Quoted content, heredocs and computed sleep durations are outside this narrow
pacing check; it is not a shell security boundary.

`ORKESTR_CLAUDE_MAX_POLL_SLEEP_SECONDS` changes the limit; `0` disables the hook.
The hook is installed alongside the status line for first and resumed turns.
Authorized work continues through its remaining phases without requiring
another user message just to proceed.

For long Codex histories, `ORKESTR_CODEX_AUTO_COMPACT_TOKEN_LIMIT=131072` passes
the native `model_auto_compact_token_limit` setting when a thread is started or
resumed. A stored `codexAutoCompactTokenLimit` on the thread takes precedence.
Unset or `0` leaves native configuration alone. Limits must be whole numbers of
at least 8192 tokens. This is opt-in: it changes the summary threshold, not the
model, reasoning effort, context-window capacity or retained transcript.
Already-running turns are not interrupted to apply configuration changes.
Compaction itself takes time and can omit older detail from the active summary;
the complete stored history remains available.

The protocol contracts are documented in the
[Claude hook reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)
and the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
