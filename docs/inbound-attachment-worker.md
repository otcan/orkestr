# Isolated inbound attachment worker

This is the reference production executor for browser-encrypted inbound
attachments. It is deliberately not enabled by default and this repository does
not install a service, scanner, key, group, or host directory for an operator.
Review and approve those local controls before enabling the feature.

## Boundary

The API retains only a local Unix-socket authentication secret, the worker
verdict public key, public age recipients, session metadata, and ciphertext.
It cannot decrypt, scan, or sign a clean verdict. The worker owns the age
private-key registry and Ed25519 signing private key. The scanner receives a
single read-only plaintext file in a new networkless bubblewrap namespace with
an empty environment and no writable host mount.

The Unix socket protocol has a version, short-lived nonce, HMAC-authenticated
request and response bodies, and replay protection. The worker signs a clean
verdict with Ed25519. The API accepts it only when the exact session, owner,
thread, key/version, processing token, ciphertext digest/size, plaintext
digest/size, and verdict lifetime match the durable claim. The handoff file is
hashed again by the API before it can be published.

## Required configuration

The API environment needs only this side of the contract. Paths must be
absolute. The ciphertext and handoff roots must be the exact paths below
`ORKESTR_HOME`; substituting another root leaves intake unready.

```ini
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED=1
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED=1
ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED=1
ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET=/run/orkestr-inbound/worker.sock
ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN=<random-32-plus-byte-secret>
ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_PUBLIC_KEY_FILE=/etc/orkestr/inbound-worker-verdict.pub
ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT=/var/lib/orkestr/uploads/inbound-quarantine/ciphertext
ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT=/var/lib/orkestr/uploads/inbound-quarantine/handoff
ORKESTR_INBOUND_UPLOAD_WORKER_TIMEOUT_MS=120000
ORKESTR_INBOUND_UPLOAD_WORKER_HEALTH_TIMEOUT_MS=5000
ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_MAX_AGE_MS=60000
```

The worker receives its own protected environment file. Do not expose this file
to the API account, browser, agent, or web process.

```ini
ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET=/run/orkestr-inbound/worker.sock
ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN=<same-local-socket-secret>
ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY=/var/lib/orkestr-inbound/keys.json
ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE=/var/lib/orkestr-inbound/verdict-private.pem
ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT=/var/lib/orkestr/uploads/inbound-quarantine/ciphertext
ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT=/var/lib/orkestr/uploads/inbound-quarantine/handoff
ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT=/var/lib/orkestr-inbound/scratch
ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ROOT=/opt/orkestr/inbound-scanner-root
ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_COMMAND=/scanner/scan-inbound-attachment
ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS=["{file}"]
ORKESTR_INBOUND_UPLOAD_WORKER_UID=<numeric-dedicated-worker-uid>
ORKESTR_INBOUND_UPLOAD_WORKER_TRANSFER_GID=<numeric-api-worker-transfer-group-id>
ORKESTR_INBOUND_UPLOAD_WORKER_BWRAP=/usr/bin/bwrap
ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_PROBE_ARGS=["--version"]
ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED=1
ORKESTR_INBOUND_UPLOAD_SCANNER_TIMEOUT_MS=120000
ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_TTL_MS=60000
```

The scanner root must contain every executable, loader, library, and data file
required by the scanner. The worker invokes bubblewrap with `--unshare-all`,
`--clearenv`, a tmpfs `/tmp`, a read-only scanner root at `/scanner`, and a
read-only plaintext file at `/input/payload`. The scanner must use exit status
`10` only for a deliberate content rejection; all other failures leave the
upload retryable and quarantined.

## Local permissions and service isolation

Create a dedicated unprivileged worker user and a narrow shared group for the
API/worker transfer. The worker owns both transfer roots, while their group is
the configured transfer group and their mode is setgid 2770. The ciphertext directory must be setgid to that group so
the API's 0640 ciphertext files are readable by the worker; the handoff
directory must be setgid so the worker's 0640 handoff files are readable by the
API. The API-created ciphertext owner directories are 0770 and the
worker-created handoff owner directories are 0730: both inherit the transfer
group, and the latter grants the API group write/execute access for the atomic
handoff-to-staging rename without directory listing access. The worker private
registry, signing key, and scratch directory are owned by the worker and mode
0700/0600. The API account must not have access to them.
The scanner root is read-only to the worker. The scratch root stays worker-only
0700. `ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_PROBE_ARGS` is required in
production and must invoke the approved scanner's safe readiness operation;
the worker runs it inside bubblewrap during startup and health checks. The
scratch and handoff roots must be on the same filesystem because clean output
is renamed atomically between them. Do not place any of these private
files under `ORKESTR_HOME/secrets`.

The reference worker command is:

```sh
node scripts/orkestr-inbound-attachment-worker.mjs
```

Run it under a supervisor with a dedicated `User` and `Group`, a private runtime
directory for the socket, `NoNewPrivileges=true`, `PrivateNetwork=true`,
`PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, and restrictive
`ReadWritePaths` limited to the worker key registry, scratch, and handoff root.
Make the ciphertext and scanner roots read-only. Restrict address families to
Unix sockets and apply memory, task, CPU, and start/stop time limits. The
worker itself refuses production startup as root, without its configured UID,
without bubblewrap, or without a private signing key with strict permissions.
If a kernel or host policy prevents unprivileged bubblewrap namespaces, keep
the feature disabled rather than substituting the API process or an unsandboxed
scanner.

## Operations

`GET /api/attachment-encryption/inbound/status` performs a short worker health
probe. A failed probe blocks new sessions. If the worker fails during a scan,
the API keeps ciphertext and marks the processing result retryable; it does not
release an attachment. On worker start, only the worker scratch root is
cleared. The normal quarantine sweeper handles lease-fenced staging/handoff
cleanup and never deletes a live owner’s work.

Pause intake with `ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED=1` while rotating the
local socket secret, worker signing key/public key, scanner image, account
permissions, or supervisor policy. Health/readiness is not approval to enable:
the operator still needs scanner review, key-backup approval, filesystem/group
review, and host isolation verification. There is no production bypass flag.
