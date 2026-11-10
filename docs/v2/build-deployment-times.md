# Artifact build and deployment timestamps

The About panel independently reports each web/server artifact's build-script
execution time, embedded at compilation (`ORKESTR_V2_COMPILED_AT_UNIX`). This is
UTC, not a Git commit date, artifact filesystem modification time, first page
load, or service start. Cargo cache reuse preserves that artifact's original
stamp. Existing artifacts without a stamp display **Not recorded**.

Deployment is a separate operator record. The selected release actuator must
record the actual successful activation time in its durable release receipt and
supply these non-secret values to the selected server process:

- `ORKESTR_V2_SERVER_DEPLOYED_SOURCE`: the full server source commit.
- `ORKESTR_V2_SERVER_DEPLOYED_AT_UNIX`: recorded server activation UTC seconds.
- `ORKESTR_V2_WEB_DEPLOYED_SOURCE`: the independently activated web source.
- `ORKESTR_V2_WEB_DEPLOYED_AT_UNIX`: recorded web activation UTC seconds.

These are protected deployment configuration, not browser/request input. Never
set them to the service restart time or build time as a substitute. Preserve the
record across restarts of the same deployment. On rollback restore the selected
artifact's associated activation record; record a new activation time only when
that rollback activation actually occurs, and retain the preceding audit record.
This PR does not modify any private release actuator or live configuration.

`GET /api/v2/health` adds `deployment` format
`orkestr-v2-deployment-times-v1` with independent `server`/`web` source-bound
records. Invalid/missing values are null. The server checks its own source; the
browser checks both records against the currently executing web and reported
server sources. A stale receipt cannot label different code. A deployed UI can
have a different activation time from its backend. No timestamp proves release
acceptance or readiness. The top-right badge shows both, explicitly labeled.

Before release, the deployment owner must wire the source-bound receipt values
into the existing selected train and verify the public projection against the
actual activation receipt. Until then **Not recorded** is intentional. This
source change alone cannot recover historical deployment times.
