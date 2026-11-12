# Artifact build and deployment timestamps

The About panel independently reports each web/server artifact's build-script
execution time, embedded at compilation (`ORKESTR_V2_COMPILED_AT_UNIX`). This is
UTC, not a Git commit date, artifact filesystem modification time, first page
load, or service start. Cargo cache reuse preserves that artifact's original
stamp. Existing artifacts without a stamp display **Not recorded**.

Deployment is a separate operator record. The selected release actuator must
record the actual successful activation time in its durable release receipt and
supply these non-secret values to the selected server process:

The release train supplies them through a record file the server re-reads on every
`/api/v2/health` request (`ORKESTR_V2_DEPLOYMENT_RECORD`, default
`/var/lib/orkestr-v2-control/deployment-times.json`). A sealed package cannot take new
environment at activation, and the web is published after the server starts, so a file is the
only way to carry both times. Format `orkestr-v2-deployment-record-v1`:
`{"server":{"source_commit","deployed_at_unix"},"web":{...},"history":[...]}`. The server
ignores the file unless it is a regular file, owned by root (the default path), and not group
or world writable; a server record is shown only when its source equals the running build. The
environment variables below remain as a fallback.

- `ORKESTR_V2_SERVER_DEPLOYED_SOURCE`: the full server source commit.
- `ORKESTR_V2_SERVER_DEPLOYED_AT_UNIX`: recorded server activation UTC seconds.
- `ORKESTR_V2_WEB_DEPLOYED_SOURCE`: the independently activated web source.
- `ORKESTR_V2_WEB_DEPLOYED_AT_UNIX`: recorded web activation UTC seconds.

These are protected deployment configuration, not browser/request input. Never
set them to the service restart time or build time as a substitute. Preserve the
record across restarts of the same deployment. On rollback restore the selected
artifact's associated activation record; record a new activation time only when
that rollback activation actually occurs, and retain the preceding audit record.
The private release train writes the record: the server entry after the new server is healthy,
the web entry after the public UI publish, and both again when a rollback actually activates.

`GET /api/v2/health` adds `deployment` format
`orkestr-v2-deployment-times-v1` with independent `server`/`web` source-bound
records. Invalid/missing values are null. The server checks its own source; the
browser checks both records against the currently executing web and reported
server sources. A stale receipt cannot label different code. A deployed UI can
have a different activation time from its backend. No timestamp proves release
acceptance or readiness. The top-right badge shows both, explicitly labeled.

Until the train records an activation, **Not recorded** is intentional. Historical
deployment times cannot be recovered.
