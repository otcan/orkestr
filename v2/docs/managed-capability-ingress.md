# Managed capability ingress preparation

`codex_service/managed_ingress.py` is an inert, tested Root-side observer. It is
not enabled by package configuration or the manager, does not issue Core
authorization, and cannot execute a helper or publish a Root request. The split
startup gate remains closed.

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

Before activation this observer still requires Core-issued, durable, one-use
authorization derived from the currently consumed Deep dispatch, authenticated
Core-to-Root consumption/result ports, protected Root-request publication,
cancellation and end-to-end used-mode acceptance. Migration 0093 is reserved
for that separate Core implementation; this preparation adds no migration.

Standard provider-created MCP stdin pipes are not an authenticated origin
channel between processes sharing an executor UID. A fixed stdio forwarder must
not turn arbitrary bytes received there into Root-attested native intent.
Potential streamable-HTTP MCP support requires separate kernel connection-owner
qualification; TCP has no Unix SO_PEERCRED equivalent. Existing operator
terminals and sudo policy are unchanged.
