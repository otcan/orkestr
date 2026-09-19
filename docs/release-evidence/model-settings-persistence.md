# Model settings persistence

## Scope

Prevent historical Codex turn metadata from overwriting an explicitly configured
model, reasoning effort, or service tier. Reset-to-default remains authoritative.
Thread summaries use the same precedence as persisted metadata. Observation
writes re-read the current record under the existing mutation lock, preventing
a slow observation from overwriting a newer settings command.

The patch extracts a focused helper rather than expanding the runtime scheduler.
It preserves historical observation behavior for threads without explicit settings
and continues refreshing usage/provider metadata. It does not change routing,
permissions, prompts, model defaults, or the Codex executable.

## Local verification

- `npm run build`: passed (server and web).
- `npm run oss:boundary-check`: passed, 780 files scanned.
- `node --import ./test/test-bootstrap.mjs scripts/smoke.mjs`: passed.
- `node --import ./test/test-bootstrap.mjs --test --test-concurrency=1 --test-force-exit test/codex-app-server.test.js test/threads.test.js test/codex-thread-settings.test.js test/codex-observed-metadata.test.js`:
  passed, 293 tests, zero failures or skips.
- `git diff --check`: passed.

Coverage includes repeated stale refresh, reset-to-default, legacy/executor-only
settings, conflicting snapshot timestamps, corrupt observations, UI precedence,
a concurrent settings command, and app-server settings changes with zero model
turns or steering calls. Existing contained-policy and notification tests pass.

The first broad concurrent invocation exited without a complete test summary;
verification was repeated with the CI-standard serial file execution and an
explicit force-exit for test-owned background timers. No product behavior or
test assertion was weakened. Fresh dependencies were installed after the old
workspace dependency set lacked a required package.

## Release plan

Untagged main release; no package version bump. Remote CI must pass before
activation. The requested deployment is broker-local: preserve external Codex
turns, keep the existing routed WhatsApp account healthy, and do not restart
unrelated connector, public-site, or tenant services. Real WhatsApp E2E is not
requested and is not a gate. Preserve unrelated dirty parent-workspace changes
outside this release and report their branch-alignment exception explicitly.

After activation, reapply intended settings through the supported thread command
path, verify command outcomes and repeated thread/history reads, and retain a
private per-thread before/after audit. No work should be replayed or started merely
to verify configuration.
