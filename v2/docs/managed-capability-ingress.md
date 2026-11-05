# Managed capability ingress preparation

The explicit split-only selected-plan option `managed_operations: true` prepares
a Root-side observer and authority control ports. It remains off by default.
The production split startup gate remains closed; no existing session or
operator terminal is changed by installing this source.

The optional future channel uses a Root-owned Unix SEQPACKET socket. Socket
creation peer credentials and fresh SCM_CREDENTIALS on the packet must name
the same original PID/UID. An inherited connection does not transfer caller
authority. Root retains the actual caller pidfd, requires NNP, verifies original
managed broker ancestry and its existing window custody records, and reads role,
conversation, binding and resume setup from its protected launch journal.
Caller JSON cannot supply those fields. Fast and Worker processes cannot borrow
Deep authority, including a Fast launcher whose metadata is a read-only Deep
projection.

Closed operations currently describe a desk operation identifier or a Root
request's action, resource and **agent-requested summary**. The latter is never
verbatim owner input, owner approval, a decision, or an overrule. Request bytes
are bounded; every window has a durable claim bound. An exact retry finds the
same claim; changed content conflicts. Loss of the caller or manager produces
an unknown outcome. Journal files alone never reconstruct live caller proof.

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
qualification requirement; the short kernel tests do not establish that parity.

Before activation this path still requires a protected provider-facing client
and native advertisement, full separate-UID Core/Root end-to-end acceptance,
used Claude/native resume acceptance, watcher delivery, and failure injection.
The old fresh-only dynamic-tool desk path is not yet replaced for resume.

Standard provider-created MCP stdin pipes are not an authenticated origin
channel between processes sharing an executor UID. A fixed stdio forwarder must
not turn arbitrary bytes received there into Root-attested native intent.
Potential streamable-HTTP MCP support requires separate kernel connection-owner
qualification; TCP has no Unix SO_PEERCRED equivalent. Existing operator
terminals and sudo policy are unchanged.
