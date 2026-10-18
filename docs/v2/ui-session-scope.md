# Browser session presentation isolation

An authenticated global conversation ID is the in-page draft retention namespace,
not an authorization credential. On successful login/resume, a changed binding
clears all previous drafts and pending message requests. Same-binding sign-in may
retain drafts, including their original uncertain-retry identity. No cross-owner
cache is restored, and no browser storage is used. Without an explicit stable
owner ID, a changed global conversation conservatively discards drafts.

Confirmed logout and session expiry invalidate the UI session generation and clear
projects, pending project requests and selected conversation. Conversation/history
components unmount, removing their authorized projections. Execution authorization
loss also clears samples, resource/progress state and canonical revision cache.
Old asynchronous project/history/message/stream results check the captured session
generation before dispatch or shared-state writes; they cannot clear a newly
signed-in owner's draft or expire that owner's session. A failed logout remains
visibly unconfirmed rather than claiming server revocation.

Executable regressions cover same-binding draft retention, owner change, late
receipt fencing, invalid identity and execution projection clearing. These are
client state/build checks, not multi-owner browser/session security acceptance.
No ordinary execution routes or controls are activated by this change.
