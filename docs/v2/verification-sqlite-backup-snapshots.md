# SQLite snapshot backup independent review

Reviewed PR115 exact `3f2386c992d55bd6e3080342696f77fd1879b5b9`. **Clearance held: configured-path normalization can omit a live canonical database from snapshot staging while copying it raw.**

The application agent-job resolver trims `ORKESTR_AGENT_JOBS_DB`; the snapshot helper does not. With a fresh synthetic home as working directory, a database `agent.sqlite`, and override ` agent.sqlite `, the exact backup command succeeds. Its manifest reports `complete: true`, zero database snapshots and zero snapshot bytes, while the archive contains raw `state/agent.sqlite`. The helper checks/excludes the nonexistent space-padded name instead of the actual application database. Connector inbox also trims its configured override and requires the same resolver-parity audit. This is a concrete bypass of the per-database snapshot guarantee; no cross-database consistency claim is made.

Repair should mirror each canonical application resolver, exclude the actual normalized database and all companions, and add this regression. No installed files were changed; the reproducer used only a disposable synthetic database/archive and removed its temporary home.

The exact supplied policy/snapshot tests independently passed **10/10**, zero skips; this is distinct from the author's reported 18 tests. The snapshot test includes concurrent WAL writes, restored integrity/hash/layout, timeout, malformed database, exclusion and signal cleanup assertions. Backup-API staging is read-only at the SQLite source connection and publishes only after target integrity/budget checks and successful archive/compressor checks. Shell cleanup owns private staging and pending output; no SIGKILL cleanup guarantee or cross-store writer barrier is inferred.

Retained private raw log SHA-256 values: supplied tests `50d8e257cf77e7d80eeb53173649e7dc8ba0f4b73e56e61f2e0ea3a2368d8595`; independent normalization probe `9dfcf652d9462943d9fdeeec0b2d4dbf5af62e20be0337aa1976cab4024b7894`.

## Corrected successor

Exact `d0b2127623c1cc2fb16acc49b04b317c814ffb6f` clears the bounded resolver/archive-namespace blocker. Independently repeated the same padded-relative override inputs and assertions in a retained synthetic probe: both ordinary `state` and `snapshot-overlay` home names produce one recorded SQLite snapshot, exactly one restored database member and the expected stored value. The original failing log remains unchanged; the original probe script was not retained, so this is a reproduced oracle rather than a byte-identical script rerun.

The exact successor's two supplied snapshot/lifecycle aggregate tests independently passed **2/2**, zero skips. They include two restore cycles across seven databases and three home namespaces, wildcard/padded paths, unchanged source database/WAL bytes and malformed/symlink/FIFO metadata refusal. The author’s broader 19-test count remains separate.

Source review confirms ECMAScript trimming only for the two trimming application resolvers, literal anchored canonical exclusions, a distinct overlay namespace, and bounded validated prior receipt handling without rewriting source metadata. This is per-database snapshot clearance, not a common cross-database point or host backup qualification. All independent inputs were disposable synthetic state.

Successor raw log SHA-256: independent probes `eeb1ff7ffa09e1f0536bd0f0c388ac1e71f62cf45a3f49bd388df4b94f44c5a1`; supplied snapshot/lifecycle `21eea8b85a096573ad866005b3e141e4cc233789983273a5e4ed68d16b8b5641`.
