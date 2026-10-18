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

The current broker supports Codex only. Claude's stream parser is not a launched
or stoppable provider path; Claude acceptance remains pending that composition.
