# Two configured scopes: independent Worker HTTP gate

The harness `v2/tests/two_scope_worker_tasks_http.py` runs against the immutable ordinary server at source `25b3bbb463bd1e71f7c9f2f8eb72e43348b64b4d`, SHA256 `5d7ffdbff1a98311bb54163067a5c517ee334c1e58faf7297cf1bb0168505edf`. It reuses that source's GroupCase, ordinary cookie authentication, task peer and host-identity native probe. It creates two configured conversations with owner-task policy and one independent Worker per parent. No producer modules are modified.

Run with Python, passing the pinned executable and a new private receipt directory:

```sh
python3 v2/tests/two_scope_worker_tasks_http.py /path/to/server /path/to/new-receipt-directory
```

The final run passed all assertions: valid create/exact receipt replay, changed-key-content conflict, foreign parent/run/task refusal, anonymous/invalid-cookie/foreign-installation-cookie/Origin/CSRF refusal, known unconfigured and unknown scope refusal, delegated hold refusal, independent Worker Stop and exact replay, parent/sibling survival, scoped payload tombstone and idempotent removal. Trace assertions prove exactly two native turns per scope, exact task instructions and no extra interrupt during refusal checks. Read-only task lists remain unchanged through the refusal matrix. Cleanup verifies server/native trees gone and temporary state removed. Receipt hashes include harness and reusable Python dependencies.

The first attempt used an incorrect expected status for foreign-parent creation: expected 503, actual 404. That failed receipt is retained; the corrected oracle requires 404 without weakening the refusal requirement. A second bounded run passed before adding more mutation-auth and tombstone checks; the final run includes those additions.

This is synthetic ordinary HTTP/native-peer isolation evidence. A cookie from another isolated installation is invalid here; it does not establish multi-owner support inside one installation. This does not qualify real provider tools, browser rendering, release readiness or production latency.
