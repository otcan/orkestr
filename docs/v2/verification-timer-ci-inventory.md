# Timer lifecycle migration inventory correction

The Rust CI run 39185985853 at `4ef5aaf69aa5f57f4fdc7b0882d6a739b7f4e56c`
completed the timer lifecycle behavior checks before failing its obsolete schema-33
assertion. The fixture now derives the complete version/SHA-384/success inventory
from its exact canonical migration SQL files and requires equality for both the
seed and final database. Missing, extra, changed-checksum and failed migrations
are refused; no version floor or replacement hardcoded version is used.

The Rust parent forwards child JSON and stderr on success as well as failure.
All existing lifecycle behavior assertions remain unchanged.

Independent execution of the corrected mounted test passed once in 70.24 seconds:
36 source migrations, actual schema 36, one intake, zero native runs. This includes
natural due time, creator logout, restart, historical retry, disable, actual
SIGKILL/new exec without duplicate intake, and machine revocation. Four additional
synthetic inventory mutations (missing, extra, checksum and failed) were refused.
Raw parent output, child JSON, source hashes, original CI failure hash and sampled
PID/start cleanup checks were retained privately. All three sampled process
identities were gone after completion. This is synthetic process evidence, not
provider, production timer, multi-day or mid-transaction crash qualification.
