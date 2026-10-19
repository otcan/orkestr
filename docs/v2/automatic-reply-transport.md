# Trusted automatic-reply socket leaf

This unregistered callable depends on the schema-39 automatic-reply Store API.
There is no HTTP mount, ingress producer, account selection, accepted-output
inference, legacy sender migration, or account/network activation in this slice.
The ordinary trusted ingress and frozen-output trigger require a separate root
decision. Browser JSON, history and UI state cannot supply that authority.

`server/src/automatic_reply_transport.rs` exposes:

* `reserve_and_consume(&Store, credential, &AutomaticReplyProducer,
  FrozenReply { input_id, request_key, output }, UnixStream)` transfers a socket
  and uses Core's exact reserve/consume ports. It returns `ReplyStart::Writing`,
  a read-only `Replay` receipt, or `ReconciliationRequired`. No bytes are written
  by this asynchronous setup. Core copies and hashes the frozen output.
* `ReplyWrite::step(&mut self, max_bytes)` performs at most one actual nonblocking
  write, bounded to 1..16384 offered bytes, inside the Core suffix fence. The
  callback receives only Core-retained bytes. `Pending { written_bytes }` is a
  local monotonic offset; `ReadyToFinish` is not external delivery evidence.
* `ReplyWrite::finish(self).await` consumes the fully written capability and
  returns the existing `delivery_unknown` receipt. There is no sent/ACK port.

The trusted caller must supply the producer issued for the exact privately
configured route/account and an exclusively owned connected endpoint for that
same route. This leaf does not discover, dial, select, authenticate or reconnect
an endpoint. It cannot prove exclusive ownership against a caller retaining a
duplicate FD. Such duplication, a deferred second sender, and treating a local
queue write as the actual transport effect are prohibited composition choices.
The socket tests establish bytes at the fake peer, not receipt by any remote
service. A future real adapter needs its own exact effect-boundary review.

Only `WouldBlock` maps to a known zero-byte callback result. It may be polled
again under a fresh current fence. Any other callback error, invalid limit,
Core error or uncertain commit closes/shuts down the owned socket and discards
the capability permanently. A prefix may already have escaped. Neither error,
drop, cancellation, restart nor receipt replay enables another output write.
The writer has no Clone implementation or raw FD/capability/credential getter.
Drop always shuts down the owned endpoint; async setup and finish retain that
cleanup even if their futures are cancelled. Full writing followed by a failed
finish remains uncertain, with no resend.

The integration test imports this leaf directly by path, without registering it
in the ordinary server. Tests use actual Store capabilities, synthetic routes
and account labels, isolated SQLite files, and owned Unix socketpairs. They
cover frozen exact bytes, suffix offsets, read-only replay, default-disabled
permission, disable/hold/route replacement/revoke before first or later suffix,
actual EAGAIN, peer failure and partial drop/early finish. The EAGAIN test fills
only its fake socket before transfer to force a known nonblocking no-write;
this setup is not a production ingress pattern. Core's separate commit-failure
tests are not attributed to these socket tests.
