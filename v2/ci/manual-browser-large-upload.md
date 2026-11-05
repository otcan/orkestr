# Opt-in browser attachment acceptance

`manual-browser-large-upload.mjs` exercises a real disk-backed
1,000,000,000-byte `File` in a fresh headless Chromium profile. It imports the
production composer JavaScript helper, enrolls a browser age key against a real
candidate backend, streams through a representative local reverse proxy and
verifies the complete provider file from a different execution UID. It also
rejects an actual disk-backed 1 GB + 1 byte file before any chunk is sent.

This is not the full WASM composer, a business provider, a live desktop, or the
production reverse proxy. The proxy uses a 1,114,112-byte request-body limit and
a 20-minute request timeout. The backend retains its own authenticated
15-minute preparation deadline. Resource limits are enforced by uniquely named
transient systemd units: browser 2 GiB and backend 3 GiB, each with a 200% CPU
quota. Cgroup memory includes filesystem page cache; it is not process RSS.

Explicitly set `CI=true`, `ORKESTR_RUN_BROWSER_1GB=1`, `V2_SERVER` to a candidate
release binary and `EXPECTED_CANDIDATE_COMMIT` to its complete 40-hex embedded
source identity. `ACCEPTANCE_REPORT` selects a private JSON receipt. The harness
requires installed Puppeteer/esbuild/age dependencies, Chromium, noninteractive
sudo, systemd and Linux setpriv. Synthetic numeric service UID 62001, execution
UID 62002 and shared GID 62003 must be unregistered and unused; no accounts or
groups are created. Only a newly created test directory is chowned or removed.

Core and the ingest identity stay in a service-owned 0700 home; provider files
use the supported external export directory and group-readable 0640 files.
Receipts record the candidate binary/module hashes, actual data size/checksum,
proxy byte counts, resource limits, cross-UID read/deny results and cleanup.
They contain no real credentials. Keep results outside source control. The
historical frozen baseline did not qualify bootstrap-file isolation or automatic
crash orphan cleanup. The current harness provisions a random synthetic 0600
bootstrap file in the private service home and reads it after dropping UID;
the token is never a transient-unit command argument. Worker checks deny reads
of Core, bootstrap and ingest identity.

Set `ORKESTR_ACCEPTANCE_CRASH=1` to kill only the disposable backend unit while
it is writing a private incomplete export, verify worker denial, restart using
the same Core/key and verify startup cleanup plus full file reconstruction.
`ORKESTR_ACCEPTANCE_BYTES=67108864` selects a bounded 64 MiB crash rehearsal;
that run explicitly does not exercise or claim the 1 GB limit acceptance.
The default still uses the real 1,000,000,000-byte disk file. Failed checks
retain a failure receipt, and the harness removes all disposable scratch.

Cross-UID host reads do not by themselves qualify a bounded provider namespace:
its sealed read-only mount or scoped file-descriptor transport must also make
the published file visible. Neither the private Core nor ingest-key directory
may be mounted to achieve that.
