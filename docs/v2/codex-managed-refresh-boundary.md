# Managed Codex auth refresh gate

The pinned native's locally generated `v2/LoginAccountParams.json` marks the
`chatgptAuthTokens` variant internal-only and says not to use it. That
version-specific restriction governs this release despite newer public
[app-server documentation](https://learn.chatgpt.com/docs/app-server) describing
an experimental host-owned external-token flow. No external-token login, external-token refresh callback, API-key fallback or
new account route is enabled here.
Synthetic regression tests keep login/logout, forced metadata refresh and the
server external-token refresh request outside the closed broker protocol.

The current isolated connector mounts selected canonical managed auth read-only.
That proves neither refreshing expired access tokens nor persisting a refresh.
It must not acquire write access to canonical auth, copy a credential cache,
inherit account settings, or answer a 401 by resending a consumed turn.

A supported managed design requires one host-private owner for the canonical
account lifecycle, serialized with every other executor using that account.
That owner alone may perform a supported native managed refresh and persist the
result. Ordinary Runtime receives only an opaque selected-account generation
and an immutable launcher capability, never tokens or credential paths. The
private launcher can mount the selected canonical auth read-only in a newly
owned child after an owner-completed refresh; atomic canonical file replacement
requires a fresh bind, not an assumption that an existing mount sees new bytes.
Native account/read remains refreshToken=false in the isolated metadata path.

Refreshing that account does not authorize inference. A later accepted-session
continuation still requires its exact Core grant, prior terminal/owner acceptance
and complete prior-tree reap, a fresh child/FD lineage, and the actual-write
fence. An uncertain or failed turn is not eligible for automatic resend after
refresh. Owner refresh failure, selected identity change, logout or unavailable
serialization must refuse/quarantine with sanitized errors, never select another
account or change subscription billing. No provider wait belongs inside SQLite.

The missing integration primitive is a root-owned refresh owner shared with
existing production executors, plus a reviewed account identity/generation receipt. The pinned
`v2/GetAccountParams.json` explicitly supports `account/read` with
`refreshToken:true` as proactive normal refresh-token flow in managed mode. This
is distinct from the forbidden internal-only external-token route. A per-process Python lock or
metadata boolean would not establish that ownership. Until those are reviewed,
auth refresh remains unresolved; current successful startup/continuation probes
are compatibility evidence only. Do not rotate live canonical auth merely to
manufacture expiry evidence. Synthetic stale-generation/refusal and in-flight
uncertainty tests must precede any independently approved isolated native probe.

## Selected-profile composition adapter

`isolation/managed_codex.py` now supplies `ManagedCodexOwner` and its one-use
`SelectedManagedProfile.launch()` handle. The private composition constructs one
owner with a fixed selected identity, a metadata-only snapshot callback returning
exactly identity/generation/state, and a fixed bounded owned-spawn callback. The
ordinary server receives only selected handles. It cannot supply paths, account
identity, credentials, environment, or refresh arguments through the handle.
The launcher callback must construct a fresh reviewed isolated profile/bind at
spawn time, not reuse an old credential inode or existing native process.

Selection, refresh completion and actual bounded launch are serialized by that
shared owner. Stale or decreasing generations, revocation and identity changes
refuse launch. Handles are consumed even on failure. A failed or non-advancing
refresh quarantines the owner and all its outstanding handles; there is no
retry/reissue or consumed-turn replay. Reconciliation requires external trusted
owner review. Errors from callbacks are sanitized. This lock must never enclose
provider inference, wait/reap, or a SQLite callback.

This is a callable composition adapter, **not host-wide serialization** by itself.
All canonical account users, including existing production executors and auth
writers, must participate in the same private owner service before activation.
External filesystem writers cannot be fenced by this Python lock. Snapshot
metadata must come from that service, not caller booleans or file timestamps.
The optional supported-refresh callback is deliberately absent by default;
unsupported refresh refuses without modifying auth. The supported pinned managed refresh operation is established by schema; a
shared production owner has not yet been established. Consequently real refresh
remains an open release gate, and this adapter is not
registered in the immutable authenticated launcher inventory.

Synthetic tests use disposable fake account bytes: concurrent refresh
serialization, atomic replacement plus stale-handle refusal/fresh reload,
revocation/identity refusal, and failed-refresh quarantine. No credentials,
provider operation, forced live rotation or ordinary server activation are used.
Core dispatch/readiness and Runtime child-reap/actual-write fences remain
independent prerequisites; a selected launch handle is never inference authority.


## Supported managed refresh callback

`isolation/managed_refresh.py` provides `ManagedAccountRefresh`, installable as
`ManagedCodexOwner`'s trusted refresh callback. It requests only
`account/read {refreshToken:true}` on a dedicated, already initialized managed
native connection. The private transport must enforce the supplied 15-second
wall deadline, 16384-byte response limit, fixed request correlation and owned
cleanup. These bounds are transport obligations, not a claim that synchronous
Python can preempt an arbitrary callback. No live transport is installed here.

The pinned `GetAccountResponse` supports ChatGPT, API-key and Bedrock accounts;
account and workspace routing may also be absent/null. This selected-subscription
adapter deliberately refuses all but exact ChatGPT/OpenAI-auth responses with
matching private email, plan, ChatGPT account ID, backend origin and routing
policy. Missing identity evidence fails closed rather than inferring identity
from successful refresh. The backend routing object is identity evidence only;
it does not configure isolated provider egress. No account payload is returned.
Only after validation does the private publisher advance the selected generation.
Publication failure or any transport/refusal uncertainty quarantines the owner;
canonical refresh may already have happened, so there is no automatic retry.

The host owner must hold sole canonical writer authority throughout native
refresh, canonical persistence, identity validation and generation publication,
and must serialize existing executors too. The adapter does not read/copy auth,
invoke login, rotate production tokens, grant canonical write access to isolated
children, or change their `refreshToken:false` metadata whitelist. Fresh launches
still use read-only selected binds. Runtime/Core readiness and actual inference
fences remain independent. Production writer topology and live managed refresh
qualification are explicitly pending root review.
