# Detached-turn CI signal triage

Bounded comparison for integration c68e2782094e7ad9c5613df9627cbbce89f25358,
full CI run 39152244925, test shard 3 job 117748471954. The recycled-PID
case failed at its signal assertion after 5018.069963 ms: actual null versus
expected SIGTERM. The shard reported 964 passed, one failed and three skipped.
This failure remains unresolved; it is not classified as a flake.

Compared main e874aad889038242bf579682a973b30d754daa4a with that integration:

| File | Identical Git blob on both heads |
| --- | --- |
| test/claude-code-detached-turn.test.js | 89300e6c8e1a903d4ed68103e7528856e87870f1 |
| packages/core/src/claude-code-detached-turn.js | 2940d91a21f351fb3535c9f36313ae2b142c3977 |

Validation used Node 22.23.1 and the repository test bootstrap. Source snapshots
were extracted with `git archive` into separate temporary directories; synthetic
homes and all signalled process groups were created by the probes themselves.
No production process, provider session, credential or dependency resolver was
used.

The normal command was attempted first:

```sh
node --import ./test/test-bootstrap.mjs --test \
  --test-name-pattern='a recycled pid' test/claude-code-detached-turn.test.js
```

It fails before test execution because this checkout lacks `age-encryption`,
imported through unrelated test-file dependencies. This is a local validation
limitation, not the CI signal failure.

Focused validation imported the unchanged detached-turn helper and its storage
and exit helpers from each pinned archive. The original recycled-PID test body
(including its five-second synthetic child, PID identity checks and signal-log
assertion) ran 20 times on each head, all passing. Only unrelated imports and
runtime-reset teardown were omitted; temporary-home cleanup remained. This is
not a full-file or shard pass.

Additional focused probes per head passed 680/680: 40 immediate signals, 40
signals after synthetic child readiness, 300 signals after a randomized 0–4 ms
launch delay, and 300 immediate signals including the original mismatched-start-
time/state checks. These probes used a shorter synthetic child delay. Across
both heads all 1,360 probes observed SIGTERM, with no skipped cases. An early
probe omitted the facade line subscription and was corrected before collecting
these results; its stalled runner was terminated by its owned PID only.

The five-second CI duration is consistent with the synthetic child reaching its
normal timeout, but it does not prove where the group signal was lost. Identical
source and passing local probes do not establish the root cause or exclude a
runner-specific launch race. No speculative production or test fix, skip, or
assertion weakening was applied. Remaining evidence needed is reproduction in
the CI shard environment with launch/readiness and owned process-group state
captured around the signal.
