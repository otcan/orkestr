# Isolated provider acceptance preparation

`verify_package.py` is a read-only preflight for a separately reviewed, fixed
Codex broker installation. It never starts the server, broker, or provider. It
does not read provider credentials or make network requests. It does read the
explicit configuration artifact as opaque bytes to verify its hash; that file
must contain path references only, never credential values.

The operator-supplied manifest is private installation input. Keep it outside
the repository. It has exactly these fields:

```json
{
  "schema_version": 1,
  "mode": "isolated-codex-acceptance-v1",
  "server_source": "<40 lower-case hex characters>",
  "broker_source": "<40 lower-case hex characters>",
  "package_root": "/opt/example-acceptance/broker",
  "artifacts": {
    "server_binary": {"path": "<canonical absolute path>", "sha256": "<64 hex characters>"},
    "provider_native": {"path": "<canonical native executable>", "sha256": "<64 hex characters>"},
    "python_interpreter": {"path": "<canonical interpreter>", "sha256": "<64 hex characters>"},
    "broker_launcher": {"path": "/opt/example-acceptance/broker/launcher", "sha256": "<64 hex characters>"},
    "broker_config": {"path": "/opt/example-acceptance/broker/broker-private.json", "sha256": "<64 hex characters>"},
    "broker_server": {"path": "/opt/example-acceptance/broker/server.py", "sha256": "<64 hex characters>"},
    "broker_configuration": {"path": "/opt/example-acceptance/broker/configuration.py", "sha256": "<64 hex characters>"},
    "broker_protocol": {"path": "/opt/example-acceptance/broker/protocol.py", "sha256": "<64 hex characters>"},
    "broker_transport": {"path": "/opt/example-acceptance/broker/transport.py", "sha256": "<64 hex characters>"}
  }
}
```

The manifest, all artifacts, and every ancestor must be root-owned with no
group/other write permission. Files must have one link, canonical paths, bounded
sizes, stable identity while read, and the reviewed digest. The broker directory
must contain exactly the six named files, including imported Python modules.
The launcher must use a fixed isolated interpreter and disable bytecode writes.
The OS, root operator, and interpreter standard library remain trusted; this is
not same-UID filesystem isolation or protection against a hostile root.

```sh
python3 -B v2/acceptance/provider/verify_package.py /opt/example-acceptance/manifest.json
```

Receipts contain hashes, source pins and fixed failure codes. They do not contain
file contents, provider responses, prompts, tokens or account details. Review
source and provenance before installing the root-owned package; hashes alone do
not establish that the selected program is safe. Re-run immediately before each
authorized acceptance launch. The verifier does not approve or launch it.

Filesystem regressions use real protected ancestors and disposable fixtures
under `/opt`; they intentionally require root. A non-root run reports skips.
They never execute the fixture artifacts or access canonical accounts:

```sh
python3 -B -m unittest discover -s v2/acceptance/provider -p 'test_verify_package.py' -v
```

Real acceptance still requires the ordinary server's private configuration,
transaction-time owner authentication, single-use dispatch, same-child native
identity, the actual provider stdin write fence, and scoped Stop/cleanup review.
A durable Stop receipt is intent until interruption or process cleanup is
confirmed. A provider result is a proposal until the authenticated owner accepts
its exact durable completion event and revision. Test a fresh synthetic role
session, then historical receipt replay, before any follow-up on that role.
Never adopt a V1 native session or use another account as a substitute.

`prepare_http.py` prepares that private configuration without activating it.
Create a fresh mode-0700 state root containing only empty mode-0700 `workspace`,
`provider-home`, and `provider-tmp` directories. The pinned broker configuration
must select exactly those paths and the manifest's native executable. After the
complete package has been reviewed and installed:

```sh
python3 -B v2/acceptance/provider/prepare_http.py \
  --manifest /opt/example-acceptance/manifest.json \
  --state-root /srv/example-acceptance
```

The script launches the pinned ordinary server with execution disabled and a
deliberate environment allowlist. Through loopback HTTP it sets up a fresh
synthetic owner, obtains separate machine and cookie sessions, checks that no
execution exists, and stops its server. It then writes mode-0600 `execution.json`,
`machine-token`, `synthetic-session.json`, and a metadata-only `prepared.json`.
No message is admitted and no provider launcher is invoked. It refuses a reused
state root; failed preparation must be inspected rather than retried in place.
Keep the synthetic session files private. They must never enter Git or logs.

An attended continuation must separately review the exact configuration digest,
actual-write/Stop implementation and private launcher before setting
`ORKESTR_V2_EXECUTION_CONFIG`. Preparation does not make that activation safe.

The current broker supports Codex only. Claude's stream parser is not a launched
or stoppable provider path; Claude acceptance remains pending that composition.

The independent byte oracle can examine an exact source archive that includes
the broker's synthetic protocol fixtures:

```sh
python3 -B v2/acceptance/provider/writer_oracle.py \
  --broker-root /private/review-source/v2/provider-broker
```

It starts only a raw-byte collector through the broker pump's fixed test
configuration. After a valid synthetic CommitExecution is prepared, closing the
handed-off writer must produce EOF with zero bytes; after writing a short prefix,
EOF must contain that exact prefix without a suffix or replay. This establishes
sole writer ownership and actual byte effects, not durable Store cancellation
or revocation race behavior. Those require the Runtime/Core integration tests.

`codex_reuse.py` is an attended **activation** driver, not another preflight.
Use it only after explicit review of the exact immutable package, private
configuration, ordinary server composition and driver source. It consumes one
fresh preparation and refuses a second activation attempt. The selected native
executable and canonical account reference require operator review; their hashes
alone do not identify a provider or authorize launching it.

```sh
python3 -B v2/acceptance/provider/codex_reuse.py \
  /opt/example-acceptance/manifest.json /srv/example-acceptance
```

The two prompts request harmless exact text without tools or other effects. The
second asks for the previous answer plus a new token. It is queued before the
first completion is accepted; the driver verifies that it waits for the owner,
then requires the same native PID/start identity and durable native session for
both distinct runs. Historical acceptance replay must leave the successor
unchanged. Both owner receipts must survive a restart with execution disabled.
This qualifies only that bounded two-turn path; Stop, steering, additional roles,
crash recovery and OS credential isolation remain separate gates.

Each proposal has a 45-second deadline inside a 90-second overall work deadline.
A 120-second signal guard bounds the CLI. Termination signals are deferred during
the cleanup's bounded waits so they cannot leave owned children halfway reaped.
The event stream refuses redirects just like the ordinary HTTP helper. Output
text remains private; receipts contain digests and counters. Synthetic native
validation must pass `evidence_scope="synthetic_native_fixture"` to `run` and
must never be reported as real provider evidence.

`codex_stop.py` is a separate attended activation against an explicitly reviewed
Stop-capable server. It requires a fresh preparation and asks the native provider
for a harmless number list without tools. After real streamed progress and a live
Stop capability, it submits owner intent with both the original snapshot revision
and its explicit positive run control revision. It makes one submission: any
conflict or uncertain delivery fails the acceptance, without refreshing the run,
precondition or intent. Only an identical successful receipt may be replayed.

```sh
python3 -B v2/acceptance/provider/codex_stop.py \
  /opt/example-stop-acceptance/manifest.json /srv/example-stop-acceptance
```

The receipt initially means `requested_unknown`. Passing requires one durable
terminal stopped observation, a cancelled run, an acknowledged control outbox,
idempotent receipt replay, and normal reaping of the same owned provider tree
before server shutdown. An acknowledgement alone must fail this acceptance as
unconfirmed. A disabled restart must retain cancelled status while returning
503 for control delivery; this does not qualify configured restart recovery.
No completion is accepted, no successor is dispatched, and no raw output enters
the receipt. Streaming is bounded to 45 seconds, terminal evidence to 6 seconds,
and the CLI to 75 seconds with protected bounded cleanup. Synthetic terminal and
ACK-only fixtures must use the explicit synthetic evidence scope. Steering,
other provider roles, and OS credential isolation remain separate gates.

`codex_stop_peer.c` is the synthetic native fixture for both outcomes. Compile
once with `-DACK_ONLY=0` and once with `-DACK_ONLY=1`, using
`cc -O2 -Wall -Wextra -Werror`. Install each as the reviewed manifest's native
executable in a separate private preparation, with an empty synthetic Codex home.
It makes no inference or network requests. Its workspace trace records only
spawn/turn/interrupt counters and PID; require one turn, one interrupt, and one
PID in each case. The terminal variant must pass the driver. The ACK-only variant
must fail with `provider_stop_unconfirmed`, zero stopped observations, pending
control, and complete normal cleanup. Never use a real provider identity for
these synthetic tests.

Also compile a terminal variant with `-DSTOP_PROGRESS_BURST=32`. It emits 32 valid
current-turn progress deltas between interrupt acknowledgement and terminal
interruption. The same acceptance must pass, preserving bounded output retention
without losing the later explicit terminal evidence. Keep the failing baseline
receipt when testing a runtime repair; do not relabel this fixture as a provider.
