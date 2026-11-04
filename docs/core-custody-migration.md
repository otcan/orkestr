# Offline Core authority staging

`scripts/sre/core_custody.py` provides executable preflight, schema-preserving
SQLite backup staging and guarded rollback. It does not alter source data,
service identity, package files, systemd configuration or running processes.
Staging is preparation; the coordinated release train owns the actual cutover.

A protected authority directory must be separate from executor-owned state. A
file-only `chown` inside an executor-writable parent leaves rename/replacement
attacks possible. Changing a shared server/provider UID also preserves executor
access. Qualify an actual split of server authority identity and provider
executor identity before staging.

Provide a private configuration with `source_core`, `target_root`, `service_uid`,
`service_gid`, `agent_uid`, `unit` and `candidate_descriptor` paths/identities.
No real deployment values belong in this public repository. The authority root
must not exist yet, and its ancestors must be protected. A protected root-owned
qualification receipt binds these fields and the candidate descriptor SHA256 and
attests successful separate-identity, agent read/write denial, provider/broker,
startup-closure, direct-consumer and authenticated-provenance probes. These are
release qualification evidence, not booleans an executor may self-certify.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B scripts/sre/core_custody.py \
  --config /private/migration.json
```

Without `--apply`, every mode performs preflight only. Explicit offline staging:

```sh
sudo env PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B scripts/sre/core_custody.py \
  --config /private/migration.json --qualification /private/qualification.json \
  --receipt /private/stage-receipt.json --mode stage --apply
```

The service must already be stopped by the authorized train and no process may
hold Core/WAL/SHM descriptors. The utility never stops it itself. Run this stage
inside the train's exclusive maintenance window; descriptor observation is not
a cross-process lifecycle lock. Source files remain authoritative until the train
activates the independently sealed candidate. No live application data is copied
by default preflight or synthetic tests.

Rollback before cutover removes only the exact unchanged staged SQLite file and
its otherwise-empty directory, leaving the source untouched. It refuses changed
data, open descriptors, a running service, symlinks and partial/unknown stages.
After cutover or a crash in staging, use operator reconciliation and the train's
backup/rollback procedure; this utility will not erase new authority data.

Tests execute actual synthetic SQLite backup, schema/integrity verification,
private report modes, altered-data refusal and rollback. Ownership syscalls are
injected so tests do not require root or change host accounts:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B -m unittest discover \
  -s scripts/sre/tests -p test_core_custody.py -v
```
