# Managed capability ingress preparation

The explicit split-only selected-plan option `managed_operations: true` prepares
a Root-side observer and authority control ports. It remains off by default.
The production split startup gate remains closed; no existing session or
operator terminal is changed by installing this source.

The metadata/control channel uses a Root-owned Unix SEQPACKET socket. Socket
creation peer credentials and fresh SCM_CREDENTIALS on the packet must name
the same original PID/UID. An inherited connection does not transfer caller
authority. Root retains the actual caller pidfd, requires NNP, verifies original
managed broker ancestry and its existing window custody records, and reads role,
conversation, binding and resume setup from its protected launch journal.
Caller JSON cannot supply those fields. Fast and Worker processes cannot borrow
Deep authority, including a Fast launcher whose metadata is a read-only Deep
projection.

The original effect operations describe a desk operation identifier or a Root
request's action, resource and **agent-requested summary**. The latter is never
verbatim owner input, owner approval, a decision, or an overrule. Request bytes
are bounded; every window has a durable claim bound. An exact retry finds the
same claim; changed content conflicts. Loss of the caller or manager produces
an unknown outcome. Journal files alone never reconstruct live caller proof.

Root indexes the claim journal (`managed-requests`) in memory by window and by
run: a pending poll reads only the live callers' own claims, and run close and
the Worker waiter count read only that run's claims, so their cost does not
grow with the journal. A completed, unknown or cancelled claim of a window the
manager no longer holds is removed seven days after its last change (at most
256 per pass, checked hourly). Claims of held windows, live callers and
unfinished claims are kept. No later caller can replay a removed claim: its
key includes the window and original broker.

Migration 0093 records a durable one-use operation only after Core verifies the
currently consumed canonical Deep dispatch, original metadata setup (including
the exact resume setup locator), and active execution window, context,
incarnation and credential. A lost write or reply remains consumed. Stop,
revocation, lease loss and closing windows fence subsequent transport. Core's
bounded nonblocking Root write occurs inside its writer transaction; connection
and response waits occur outside it.

The authenticated authority server polls Root's protected observer, issues the
grant, and monitors/cancels the exact Root operation. Root checks the grant's
evidence against its original live caller record before persisting consumption.
Desk operations reuse the protected fixed helper map and Root cleanup anchor.
Root submissions enter `root-request-submissions` under the Root-private ledger
with mode 0700/0600. They preserve the actual Core message/event reference and
agent-requested summary, leave owner approval false, and explicitly report owner
delivery unconfirmed. The existing writable/shared-group inbox and sudo fallback
are never used. A private protected watcher adapter is still required before
claiming that this queue reaches owner review.

Before provider input, Core opens a run observation through its opaque Deep
parent and a live writer fence. Root stamps business requests with that run;
metadata/native registration alone cannot queue a future business request.
Closing the run cancels its unconsumed requests. A later run on the same native
cannot promote an old queued request.

The initial helper lease remains at most 30 seconds. Long owner waits use a
distinct, one-use renewal issued only from the actual same-run lease authority
after Runtime transfers the owned native. Renewal preserves operation identity,
source, resource and immutable hard deadline; it cannot enter the fresh-launch
API. Root sends only an absolute monotonic deadline over the original anchor's
private socket. It never launches another helper, asks for another owner code,
or changes arguments. The protected map caps duration at five minutes; a shorter
map remains shorter. The immutable Core hard deadline is additionally capped by
the window work deadline. Expired leases cannot revive a helper. Stop cancels
and reaps its original tree. Full 120-second owner-wait acceptance remains a
qualification requirement; the short kernel tests alone do not establish that parity.

For explicit managed-host plans, the original native receives a fixed loopback
HTTP MCP endpoint through its protected launch capsule. Codex and Claude advertise
the same closed tools at process startup, including native resume. The optional
channel replaces the fresh-only dynamic desk advertisement only when enabled.
Root matches the kernel TCP tuple/socket inode to the registered original native
PID/start and its Root-created input/output pipe pair. It checks the actual pinned
executable device/inode, NNP and retained pidfd; descendants and unrelated same-UID
processes cannot claim this identity. Registration comes only from the original
tracked broker's SCM_CREDENTIALS and direct Popen child. Native wrappers lacking
this proof remain unsupported. Yama protection is required; a copied path or
caller-supplied bearer/PID/header is never authentication.
The socket/native proof is refreshed across partial reads, before dispatch and
before every response, including after a long helper wait. A cached pidfd alone
cannot preserve authority after the original Root pipe or socket custody changes;
loss of custody fences admission and cancels an active fixed helper.

Terminal effect evidence is persisted before Core issues a distinct one-use
result release. Its writer fence verifies the still-current consumed run and
exact result hash before the bounded Root-control write. Root then checks the
original run and expiry before sending the fixed result; Stop closes pending
positive delivery. A socket write proves delivery to the transport, not native
application consumption. No successful helper receipt proves website login.

Offline probes with fake homes and no provider turns establish tool discovery
with actual Codex and Claude clients. Kernel tests cover an unrelated same-UID
native, socket-FD reopening, pidfd duplication and process-memory access. These
do not establish complete workflow parity. Disposable separate-UID Core/Root
HTTP rehearsals additionally cover both providers: one original helper waits
120 seconds through actual same-run renewals, followed by a supported drain,
exact native resume and another turn in the resumed window. Each turn submits
one protected Root request and invokes one fixed desk helper. A separate owner
HTTP Stop after renewal confirms the exact native interrupt and original helper
reap, with no positive tool result or replay of the unknown Core effect.

The native fixtures are synthetic and use no provider, Vault or website.
This establishes the capability transport and lifecycle, not an installed
helper's dependency custody or a real account login. Before activation this path
still requires the protected watcher/reviewer, credential and operator-IPC
boundaries, installed helper qualification and the remaining used-mode checks.

Run these explicit Root-only fixtures against a source-built server; they
bypass the production startup gate only inside their disposable harness:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_managed_mcp_http.py \
  /path/to/server --provider codex --report /private/codex-wait.json
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_managed_mcp_http.py \
  /path/to/server --provider claude --report /private/claude-wait.json
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_managed_stop_http.py \
  /path/to/server --provider codex --report /private/codex-stop.json
PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B v2/tests/identity_split_managed_stop_http.py \
  /path/to/server --provider claude --report /private/claude-stop.json
```

The long Codex debug rehearsal also covers a previously reproducible runtime
stack overflow at lease renewal. The SQL renewal future is boxed at Runtime's
owned-pump transfer boundary; the test uses ordinary stack sizes and preserves
all original lease and cancellation checks.

Standard provider-created MCP stdin pipes are not an authenticated origin
channel between processes sharing an executor UID. A fixed stdio forwarder must
not turn arbitrary bytes received there into Root-attested native intent.
TCP has no Unix SO_PEERCRED equivalent. Existing operator terminals and sudo
policy are unchanged. In particular NNP alone cannot prevent delegation to an
accessible same-UID privileged operator daemon. Such IPC access remains a
separate production qualification blocker, even when direct sudo is denied.

The separately gated [Native Worker bridge](native-worker-managed-bridge.md)
adds source-bound task create/status and bounded observation over the existing
Core Worker scheduler. It does not use the Desk/Root one-use operation table or
change their wire contracts. Current Core capability observation is required;
registration alone does not establish Worker readiness.

## Admission limits

Root admits a new claim only within three window bounds and paces each
original native's HTTP requests (`codex_service/managed_budget.py`). An exact
retry finds its existing claim and is never refused by the window bounds.

| Bound | Default | Refusal |
| --- | --- | --- |
| Claims of one window whose caller still waits (in flight) | 16 | 429 `managed_window_busy`, `retry_after_s` 2 |
| New claims per window: token bucket | 120 a minute, burst 48 (three waves of 16 parallel calls) | 429 `managed_window_busy`, `retry_after_s` until the next token |
| HTTP requests per original native: token bucket | 240 a minute, burst 96 | 429 `managed_native_busy`, `retry_after_s` |
| Claims one window keeps in the journal (backstop) | 2000 | 409 `managed_window_budget_exhausted` until the window closes |

The in-flight bound keeps one window from taking all of the manager's 32
shared connection slots (two saturated windows can still fill them). Core
serves one run's claims one at a time, so the last of 16 parallel calls waits
for the others within its own 35-second deadline. The backstop
counts kept claims, including those of earlier manager lives, because held
windows' claims are never removed early. Before 2026-11-18 the only bounds were
32 claims per window and 128 HTTP requests per native for their whole life, and
a refused caller's connection was closed without an answer.

Core keeps its own backstop on the managed operations of one window
(`MANAGED_WINDOW_CLAIMS_MAX`, 2000, equal to the default above). Core counts
only claims that reached it, so with equal values the manager answers first.
Core refuses only a claim the manager has already let through, and that refusal
still ends the window and its running Deep turn. A plan that raises
`window_requests_max` above 2000 must raise Core's backstop too. Until
2026-11-18 Core still stopped at 32: the 33rd host call of a busy window ended
the window, the Deep turn, and the results it was waiting for.

A refused call creates no claim and runs nothing. The caller is answered: a
tool call receives an MCP tool error (`isError`, HTTP 200, because MCP clients
treat a non-2xx status as a transport failure) whose structured content is
`{"state": "refused", "result": {"kind": "managed_refusal", "reason", "limit",
"status", "retryable", "retry_after_s", "message"}}`; other JSON-RPC requests
receive error -32000 with the same data; the CLI transport receives state
`refused`. Every other refusal of an authenticated caller is answered the same
way with its fixed reason instead of a closed connection, and a call whose claim
already exists is answered `unknown` (for example after its deadline or when
the manager stops). An unauthenticated connection is still closed unanswered.
The manager writes one stderr line per window and reason a minute
(`manager managed_refusal reason=... refusals=N`); an exhausted window budget is
an `ALERT orkestr-v2-manager managed_refusal` line.

A sealed selected plan may tune the limits with `managed_limits` (requires
`managed_operations`), for example `{"window_in_flight_max": 4}`. Fields are
closed and bounded: `window_in_flight_max` 1-32, `window_requests_per_minute`
and `window_request_burst` 1-600, `window_requests_max` 32-10000,
`native_http_requests_per_minute` and `native_http_request_burst` 1-3600. The
capability manifest reports the active limits.
