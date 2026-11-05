# Staged managed Deep desk capability

This is a fixed operation bridge, not a Root shell. Production split startup
remains disabled. The complete disposable HTTP rehearsal covers a fresh bounded
Codex Deep native, Core issuance, an authenticated Root manager, an approved
synthetic helper, actual descendant cleanup and a result delivered to that same
native call. It uses no website, Vault, real account or provider API.

The opt-in selected plan field is `desk_login: {path, sha256}`. It names a pinned,
Root-owned configuration with protected ancestry. Its closed shape is:

```json
{
  "format": "orkestr-desk-operations-v1",
  "operations": {
    "example-login": {
      "helper": "/usr/local/libexec/example/desk-login",
      "sha256": "<helper SHA-256>",
      "conversation_id": "11111111-1111-4111-8111-111111111111",
      "desk": "example-desk",
      "site": "example.invalid",
      "duration_ms": 30000
    }
  }
}
```

The trusted helper and all dependencies are operator-reviewed code. Root checks
its protected path and digest before execution. Its argv is always exactly
`helper --conversation <mapped conversation> --desk <mapped desk> <mapped site>`.
No native-provided command, site, path, environment, owner or role reaches that
argv. The helper gets only fixed PATH/LANG/bytecode settings; stdout and stderr
are discarded. Existing helper checks for the actual leased thread, site domain
and Vault item grants must remain intact. No credential is passed to the model.
External bridge/Vault/desktop credentials need separate authority-only custody;
this configuration does not make an existing shared-group bearer safe.

## Authority and uncertainty

Only the explicit managed Deep profile advertises `orkestr_desk_login`, accepting
one `operation_id`. The owned broker checks the exact native session, turn,
request and call; Fast and Worker cannot select this profile. Correlation alone
is never admission. Core retains a nonserializable parent from its consumed
canonical Deep dispatch, then revalidates live ownership, binding, lease,
dispatch fence and authorization before consuming each call.

The original metadata setup locator is separate from the current run generation:
native readiness and later turns advance the binding generation. The locator
can be created only from an original Core metadata grant. Core verifies the
same owner/conversation/session/provider namespace/incarnation and persists its
setup generation beside the current run generation in migration0091. Root
matches the original setup against its actual live managed broker.

Core commits `delivery_unknown` before the operation leaves the store. At most
eight calls per run and eight Root claims per window are accepted. Duplicate
correlation cannot issue another operation, and a changed request conflicts.
The Root-control start frame is one nonblocking write under Core's live launch
transaction; connect/read waits remain outside that transaction. Each local
launch attempt is also consumed on every outcome, including partial or unknown
I/O. Root authenticates the exact authority PID/start and independently claims
the operation before `Popen`. Neither side retries an uncertain start.

A fixed Root subreaper owns each helper. It tracks original pidfds, captures
detached descendants through kernel ancestry, kills remaining children and
requires actual `ECHILD` before reporting cleanup. The helper never inherits
its private proof socket. Root validates the anchor proof and reaps the actual
anchor before recording a terminal state. Native completion means only that
the helper finished and its tree was reaped, not that a website accepted login.

Stop, expiry, a closed window, lost broker or manager shutdown cancel the helper.
An unknown anchor receipt remains unknown and blocks retirement. If an anchor
dies and Root-owned descendants become this manager's kernel children, the
configured custody pool pins/reaps them globally, quarantines all potentially
affected work and never assigns a recovered role. Known original children are
excluded. Physical reap does not repair the operation or permit a replay.

Only Core can mint the fixed result, by consuming the original operation after
the authenticated Root cleanup receipt. Runtime checks the same pending call,
owned child and immutable bytes. Every actual native-stdin suffix uses its
dedicated current Core result fence and durable offset. A callback/commit
failure poisons the writer permanently. There is no result-body constructor or
raw helper output path for an agent.

## Qualification limits

The pinned native's `thread/resume` schema has no `dynamicTools` property. This
fresh dynamic-tool profile explicitly rejects resume. It does not establish
Claude, steering, long-running helper/lease-refresh or existing-session parity.
A fixed process-level MCP/CLI ingress with actual managed caller and Core run
proof is implemented separately in [managed capability ingress](managed-capability-ingress.md).
Its explicit managed-host option covers the fresh/resume transport; the legacy
dynamic-tool profile's limits above remain unchanged. Sessions must not be transplanted
or silently lose their native identity. Protected Root-request submission also
requires a typed agent-summary capability; writable intake or sudo fallback is
not an acceptable replacement. No owner approval/review path is changed here.

Run the source-stamped server with the root-only disposable harness:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_desk_http.py \
  /path/to/source-built/server --report /private/fresh-desk.json
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_desk_http.py \
  /path/to/source-built/server --fault-anchor --report /private/anchor-fault.json
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_desk_http.py \
  /path/to/source-built/server --stop-helper --report /private/helper-stop.json
```

The fault case waits for a real helper, detached child and grandchild, kills the
exact original anchor, and checks global original-child reap, no successful
native tool result, unknown operation/window fences and failed semantic
recovery. The Stop case sends an authenticated owner HTTP Stop during the actual
Root helper, requires its cancellation/reap before native interrupt completion,
and verifies no tool success was delivered. Fixtures require zero remaining
children. These harnesses never
activate a service or touch operational sessions.
