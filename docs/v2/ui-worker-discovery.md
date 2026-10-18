# Worker discovery web consumer

The Workers tab reads the selected conversation through the canonical browser-only
`GET /api/v2/conversations/{id}/workers?limit=25` route. Subsequent pages use
`?after={next_after}&limit=25`. Each page is a fresh bounded read, not a stable
export. The server owns authentication, scope checks and query validation.

The contract comes from Core checkpoint
`d179601114d53ac4f0585cd4d30029d0ba8f9661`. The UI validates the canonical page,
conversation, exclusive cursor and response generation before replacing its
bounded page. Page navigation clears the selected run before loading; owner
changes clear discovery and exact-run execution caches. Component disposal aborts
polling. The browser sends ordinary same-origin cookies, never authority IDs or
Bearer credentials.

Selecting a canonical Worker opens the existing exact-run execution read
`GET /api/v2/conversations/{id}/execution?run_id={run_id}`. Stop uses the selected
run's sampled capability and control revision through the existing guarded POST;
discovery state, role and recovery disposition never enable it. No Deep fallback
or inferred sibling locator is used. Recovery labels distinguish current session
identity from reconciliation required; neither offers resume permission.

The mounted screen needs the matching registered discovery route and exact-run
control registry in the combined server candidate. Unit/transport checks and a
WASM compile do not qualify mounted browser behavior or real provider Stop.
The coordinator owns the next immutable paired build; the managed browser owner
must test actual Worker discovery, selection, pagination, owner transitions and
Stop behavior against that pair. Earlier browser evidence remains pinned to its
original artifacts. Held-input presentation awaits Core's canonical boundary DTO.
