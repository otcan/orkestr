# V2 web release evidence gate

`v2/acceptance/release_readiness.py` checks an offline evidence packet against the
approved web-first replacement plan. It is a qualification gate, not a test
runner, deployment command or assertion that V2 is ready. Native iOS is a later
milestone. The existing [release train](../release-train.md) still controls merges,
publication and deployment.

No passing application evidence is shipped here. Unit-test packets are entirely
synthetic and must never be used as a release packet. Artifact hashes detect
changes; they do **not** authenticate who produced a report, verify signatures,
prove that a provider really ran, or prove that an inventory is complete. The
release owner must independently review the source artifacts and collectors.
Changing a fixture's label to `real_provider` does not create real evidence.

## Run the gate

Requires Python 3.11+ and its standard library. Keep real snapshots, inventories,
logs, configuration and provider identities in a private artifact directory, out
of this public repository. Use a redacted effective configuration manifest whose
digest changes whenever runtime configuration changes; do not include secrets.

```bash
python3 v2/acceptance/release_readiness.py /private/release/evidence.json \
  --scope /private/release/reviewed-scope.json \
  --artifact-root /private/release/artifacts \
  --revision "$(git rev-parse HEAD)" --require full_release

python3 -m unittest discover -s v2/acceptance -p 'test_release_readiness.py' -v
```

Resolve `--revision` independently in the actual candidate checkout. The tool
does not run Git, contact providers/GitHub, start services or send messages.
Exit 0 means the requested stage meets this evidence policy; 1 means a gate is
unmet; 2 means an input could not be read or parsed. JSON output includes every
stage, its blockers and the highest ready stage. The default is `full_release`;
partial development readiness cannot accidentally return success for release.

| Stage | Additional requirements |
| --- | --- |
| `development` | Offline vertical slice, crash/recovery fixtures and exact-revision CI. The actual workspace artifact may have an ordinary SemVer such as `0.0.1`. |
| `candidate` | Version `2.0.0-rc.N` or `2.0.0`; ordinary production runtime; independent real Codex and Claude flows; all used workflow parity; migration, security, supported installations, web and performance. |
| `full_release` | Actual production cutover, 72 uninterrupted hours of successful daily production use, successful release CI, artifact/provenance/version alignment and release documentation. |

Readiness is neither publication nor authorization. A candidate version can meet
full-release qualifications before a release is published; any subsequent change
to the candidate revision, binary or effective configuration invalidates its
associated live evidence. Never carry a previous soak across a material fix.

## Version 1 input contract

Both files are JSON objects with integer `schema_version: 1`. Duplicate keys,
non-finite numbers and unknown gate names are rejected. Times use UTC ISO-8601
`YYYY-MM-DDTHH:MM:SS[.ffffff]Z`. Revisions are full lowercase 40-character Git
commit hashes; SHA-256 digests have 64 lowercase hexadecimal characters.

An **artifact reference** is `{"path":"relative/file","sha256":"..."}`.
Every referenced file must exist under `--artifact-root` and match its hash.
Absolute paths, parent traversal and symlinks escaping that root are rejected.

The separately reviewed **scope** contains:

- `baseline_revision`: deployed source baseline used for the current inventory;
  `reviewed_by` and `reviewed_at`; `repository` in `owner/repo` form.
- `inventory_artifact`: the inventory source/review artifact reference. Refresh
  this inventory against the running installation, rather than an old roadmap.
- `workflows`: map of stable workflow IDs to boolean current usage. The inventory
  and its used subset must be nonempty. All `true` entries require passing parity.
- `install_targets`: nonempty unique supported target IDs, for example
  `linux-x86_64` and `linux-aarch64`; each needs install, upgrade and restore cases.
- `required_ci`: nonempty unique check names that must succeed at every stage.
  `release_ci`: nonempty unique publication/provenance check names that must also
  succeed for full release, even if conditionally skipped on PRs.
- Optional `conditional_ci_skips`: map of check name to `{"reason":"...",
  "stages":["development","candidate"]}`. Only explicitly reviewed `skipped`
  checks are eligible; no failed/pending check can be waived. `required_ci` names
  cannot have a skip exception. A `release_ci` name must succeed for full release
  regardless of a skip declaration.

The **evidence packet** contains:

- `scope_sha256`: hash of the exact reviewed scope file bytes; `generated_at`.
- `candidate`: `revision`, actual artifact `version`, `built_at`, executable or
  distribution `artifact` reference, and redacted `configuration` reference.
- `gates`: map keyed by the fixed gate names in
  `v2/acceptance/release_evidence_policy.py`. That file is the versioned, exhaustive
  case list; implementers must not invent a shortened checklist.

Every **gate record** has `status`, `revision`, `execution`, `started_at`,
`completed_at`, `expires_at`, nonempty `artifacts` references and `cases` (a map
from case ID to status). Only the exact status `passed` qualifies. All required
cases must exist; additional failed, pending or skipped cases also block. Missing
or unfinished gates stay unmet. Completed evidence must precede packet generation
and evaluation; its declared expiry cannot exceed seven days after completion.
The soak expires at most 24 hours after completion. CI retains the seven-day
window, so a 72-hour soak alone does not force another identical CI run.

Execution modes are fixed: `fixture` for the two offline gates, `ci` for CI and
release artifacts, `real_provider` for each provider, `production` for all other
gates. Production/real-provider records additionally bind
`candidate_artifact_sha256` and `configuration_sha256` to the candidate's exact
referenced files and must begin after its build. `release_artifacts` additionally
binds `candidate_artifact_sha256`. These modes cannot be substituted for one another.

## Gate-specific evidence

**CI:** `snapshot_filter: "latest"` and a `snapshot` artifact reference to the
complete GitHub REST commit `check-runs?filter=latest` response. Collect every page
without selecting only passing jobs; combine `check_runs` and retain the complete
`total_count`. The validator requires an exact count, unique check names and IDs,
matching `head_sha`, completed status and successful conclusion for every check,
except reviewed stage-specific skips. Each record includes `id`, `name`,
`head_sha`, `status`, `conclusion`, `completed_at` and its real GitHub Actions
`details_url` for the scoped repository. Failed or pending checks outside the
required list also block. Collect a fresh snapshot at qualification time to see
later attempts; the tool does not independently query GitHub or prove that a
collector supplied the latest response. Preserve the unfiltered source for review.
Copying a new snapshot cannot refresh check executions older than seven days.

**Providers:** separate `provider_codex` and `provider_claude` records contain
matching `provider`, `isolated_profile: true` and `native_sessions` with distinct
nonempty `fast`, `deep` and `worker` identities. Each must cover the entire required
flow and its own failures. Another adapter's success or a fixture is insufficient.

**Parity and installation:** `workflow_parity.cases` includes every used inventory
ID. `installation.cases` adds `clean_install/<target>`, `upgrade/<target>` and
`backup_restore/<target>` for every declared supported target. Used workflows
cannot silently move to a deferred list inside the evidence packet.

**Web:** at least `history_messages: 10000`, `busy_turn_seconds: 30` and
`composer_editable: true`, backed by the required browser scenarios and artifacts.

**Performance:** declare the measured `environment` and `measurements` with
`input_acceptance`, `stop_fencing` and `thread_load`. Each has `unit: "ms"`, at
least 100 finite nonnegative raw `samples`, and `concurrent_clients` of 10, 10 and
1 respectively. Thread load additionally requires
`access_path: "normal_user_path"`. The validator computes nearest-rank p95
(`ceil(0.95*N)`, one-based), requiring strictly below 250, 250 and 2000 ms.
An asserted percentile cannot override samples. These measure local acceptance,
fencing and visible web load, not a model response-time SLA.

**Soak:** `environment: "daily_use_production"`, `material_fixes: 0`,
`incidents: 0` and at least 72 elapsed hours beginning after the candidate build.
`segments` must cover the exact entire interval in order, with no gap or overlap
and at most one hour per observation. Each contains `started_at`, `completed_at`,
`status: "passed"`, the exact `revision`, `candidate_artifact_sha256` and
`configuration_sha256`. A fixture/canary-only soak, pending interval, revision or
configuration change, incident or material fix cannot qualify. Start a new
interval with a rebuilt/reconfigured candidate after fixes; do not concatenate
separate successful periods. Independent review must verify continuity against
the monitoring logs, not just this manifest.

**Cutover:** `environment: "daily_use_production"` and `backup_completed_at`
within the 24 hours preceding cutover start. Required cases cover the fresh
backup, active work, final import, fenced channel ownership, retained V1 data and
rollback, unknown effects, and post-transfer health/workflows. A successful
candidate or soak alone does not prove that production has actually moved.

The tool cannot make unavailable tests pass. Record honest missing/pending gates
until the corresponding runtime, real-provider, migration and production work
has produced independently reviewed artifacts.
