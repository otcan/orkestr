# Session-preserving desktop writer handoff seam

`desktop_writer_lifecycle.mjs` implements an in-process lease-port drain and
store-factory switch. It never stops, detaches, signals, clears or replaces Codex
clients. It is a source-only leaf pending independent review and registration;
there is no HTTP/CLI operator endpoint or live activation in this change.

## Why shutdown/detach is not a substitute

`codex-app-server.js::stopCodexAppServerClients` clears delivery timers then
calls the client registry stop function. Each client close marks it closed,
closes readline, SIGTERMs an owned child (with delayed SIGKILL), closes WebSocket
and rejects pending requests. External WebSocket transport survives as a daemon
process but its connection/notification routing is not preserved by close.

`codex-job-client.js::stopCodexJobClients` also closes all clients. Job clients
explicitly force stdio, including when chat uses an external daemon: they own
processes and pending attempt listeners. Server shutdown invokes both paths.
Skipping kill while closing their stdio does not preserve an active turn.
Consequently this change does not introduce a misleading preserve-session close
flag. Codex registries, delivery timers, listeners and streams remain untouched.

## Concrete API and required registration

```js
const lifecycle = createDesktopWriterLifecycle(legacyStoreFactory);
const retainedPort = lifecycle.port(environment);
await retainedPort.acquire(request);
const token = await lifecycle.pauseAndDrain({ timeoutMs: 5000 });
await lifecycle.adopt(token, reviewedNewStoreFactory, async (factory) => {
  // Only after separately proven global quiescence and retained evidence:
  await factory(environment).init();
});
```

Admission closes synchronously, including reads (PR116 reads may initialize lock
evidence). Already admitted operations settle normally. Timeout leaves dispatch
paused and never cancels work; explicit retry can finish draining. An opaque
process-local token is spent before adoption. Uncertain adoption poisons dispatch
permanently for that controller; it never rolls back to old writers against
possibly adopted state. Retained port objects resolve the new factory on their
next operation, preventing cached old-store reuse. No arbitrary-method fallback
or raw mutateState access is exposed.

Proposed shared registration, for root/integration review: put one lifecycle
instance around `packages/browsers/src/desktop-lease-store.js::desktopLeaseStore`
and return its port instead of a raw store. Preserve the raw constructors only
for reviewed internal adoption/test code. All wrapper/direct-import users must
route through the same instance in **every** process; distinct state-file
configurations require separately inventoried process scopes. Existing direct
constructor users or cached raw stores bypass this seam and must block adoption.
This leaf does not claim they have been registered or remotely drained.

Root must coordinate that registration in the release train with PR116 source
and a bounded authenticated/local operator control plane. No env-triggered
adoption, exported unauthenticated endpoint, arbitrary dynamic import path or
process-age inference is added. The callback/factory are trusted reviewed code,
not caller-supplied source files. OS/process identity does not grant product auth.

## Cross-process and first-rollout gates

The controller only proves local admission/drain. Root must establish ingress
pause and external/direct-import writer quiescence across all processes, retain
original state/lock evidence, and only then invoke the reviewed adoption callback.
A blocked heartbeat fails visibly; no browser operation should silently proceed
without its required current lease. Do not leave a drain paused indefinitely:
expiration does not renew or confer authority.

The currently installed legacy release has no such port. This source cannot
hot-patch that process or make its destructive shutdown session-preserving.
Initial rollout still needs either completed/drained owned stdio attempts and
explicit external-client reconnect qualification, or a separately reviewed
session-owner separation mechanism. If an uninterrupted owned stdio turn is
required during that initial rollout, adoption remains held. Once enrolled,
future lease handoff can occur entirely in process without server shutdown.
No existing service/installed file/browser/executor is modified here.

## Executed tests

`node --test v2/local-install/tests/desktop_writer_lifecycle.test.mjs` exercises
admission races, retained ports, timeout, operation failure, forged/replayed
transition tokens, adoption uncertainty, and a real owned synthetic stdio child
that keeps the same PID and answers before/during/after the switch. Only that
synthetic child is cleaned up by its test.

The exact PR116 source export rehearsal additionally hands off a legacy JSON
fixture to the actual new store init, verifies unchanged history/authority and
runs a current-bound local action. No provider/account/native session, installed
adoption or production session-preservation claim follows from these tests.
