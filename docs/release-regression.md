# Release Regression Runner

Use `npm run release:regression` for the attended release checks that must catch
the core operating-loop regressions before a deploy is treated as good.

By default the runner checks the local Orkestr API from `ORKESTR_API_BASE`, or
`http://127.0.0.1:$ORKESTR_PORT` when no API base is set. It verifies:

- version and readiness endpoints
- setup status includes Codex, WhatsApp, browsers, and timers
- thread summary endpoint is readable
- WhatsApp reports a ready paired account
- browser desktop sessions can be listed

Detailed JSON artifacts are written under:

```bash
$ORKESTR_HOME/release-checks/<release-id>/
```

For loopback targets, the runner automatically uses the local CLI-machine token
from `ORKESTR_HOME/secrets/cli-auth.json` when available. This lets local
protected routes prove authenticated readiness without sending that token to
remote targets. Use `--orkestr-home PATH` when `ORKESTR_HOME` is not exported,
or `--no-local-cli-auth` to disable that behavior.

Run against multiple targets by naming each API base:

```bash
npm run release:regression -- \
  --target local=http://127.0.0.1:$ORKESTR_PORT \
  --target remote=https://your-orkestr-domain.example
```

Protected remote targets need a paired cookie or auth header:

```bash
npm run release:regression -- \
  --target remote=https://your-orkestr-domain.example \
  --header "cookie: orkestr_pairing=..."
```

Real chat injection is intentionally off by default. Enable it only for a test
thread where side effects are expected:

```bash
npm run release:regression -- \
  --execute \
  --thread test-thread-id \
  --message "ORK RELEASE REGRESSION CHECK: reply exactly OK" \
  --expect "OK"
```

For public targets where protected APIs are intentionally inaccessible from the
release shell, add `--allow-auth-blocked`. Those scenarios are recorded as
skipped instead of passed, so the artifact still shows what was not verified.
If `--required-whatsapp-accounts` is set, WhatsApp readiness remains mandatory
and an auth-blocked status route is treated as a failure.
