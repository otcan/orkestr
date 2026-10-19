# Production payload integration checkpoint

This checkpoint combines the reviewed ordinary-store cancellation, recovery,
revision-guarded Stop and removable progress payload implementation from Core
`0bc3ffced736af222e4768f95f45f0d52d3518ae`, the schema-8 UI consumer from
`dcc31f55fe80edd02dc3e6e028c5c22bf584ac41`, and Runtime's Stop HTTP integration
from `bdab5c315c3253820c77203d534d46077b9b8852`.

The container listener configuration is copied from reviewed Runtime
`8bd994132e790d38fbc01ca2c8be3d353ad9661a`. Native binding remains loopback by
default. Wildcard IPv4 binding requires explicit container opt-in and origin.
The host resource sampler and public static cache remain intact.

Combined default-feature server, store and UI tests passed, including the
ordinary process crash parent and actual Stop HTTP checks. Store results were
78 passed and two parent-invoked child entries ignored. The UI Node suite passed
29 tests. Strict Clippy passed for all three packages and all targets.

The default server has no trusted execution-store configuration and therefore
cannot activate Stop or provider dispatch. Schema-9 owner acceptance is a
separate contract and consumer review. This checkpoint does not establish real
provider execution, executor isolation, migration acceptance or release readiness.

The completed managed-browser result belongs only to server `b79e6abe` paired
with UI `e6b5441a`; it is not transferred to this newer source or bundle.
