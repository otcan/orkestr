# Fast UI bounded verification

Reviewed exact UI commit `1b45baa7295150f5242eda27376b141006c071ab`.
No bounded source blocker found. This review does not establish backend compatibility or mounted browser behavior.

Fast and Deep use separate App-owned Execution signals. Both are cleared on authentication transitions and retained across keyed conversation remounts. The Fast poller retains the existing owner/selection generation checks, bounded abortable cookie-only reads and 204 absence handling. Its optional exact-run route accepts only a UUID query. The Fast panel exposes neither Worker creation nor steering.

Fast Stop selects the distinct relative `/fast/stop` path while retaining the existing frozen request reducer, request key, sampled revisions, cookie/CSRF transport and callback/drop fences. Acceptance retains the existing `/accept` request and canonical candidate run/completion/revision tuple. Fast-specific copy does not certify Deep or Worker completion. The status DTO itself does not prove provider role: exact Fast routing and acceptance ownership must be established by the matching server checkpoint.

Independently ran the unchanged execution polling and Stop bridge tests from an exact private Git export: **17 passed, zero failed/skipped**. Raw output SHA-256: `1e1710110fe227626549f1020f936257f44b1bccbb480cde00632aa88de7316d`. These synthetic bridge tests exercise Fast absence/exact-run reads and the distinct Stop path with unchanged control tuple; they do not execute HTTP against a server. Author Rust/WASM/lint counts remain separate evidence.

Pending: exact ordinary Fast backend ABI/source gate, same-owner role/run refusal and historical retry HTTP tests, matching immutable bundle and mounted browser acceptance. No product build, browser lease or provider launch was performed. Prior browser steering run02 missing-source qualification remains unchanged.
