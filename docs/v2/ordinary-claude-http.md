# Ordinary selected Claude execution checkpoint

The ordinary default-feature server supports a trusted private execution config
with `provider: "claude"`. Omission retains Codex. The existing mode, private
file, launcher hash, separate workspace, current machine credential and loopback
checks apply unchanged. Account selection belongs to the reviewed launcher;
there is no HTTP provider/account/native-session/auth selector.

Start with the existing `ORKESTR_V2_EXECUTION_CONFIG` path after preparing a fresh
owner conversation through ordinary setup/login. All other ordinary server
environment settings are unchanged. This checkpoint accepts one fresh Claude
turn; it refuses startup with existing execution history, Worker policies, or a
run budget over 45 seconds. Default execution remains disabled.

Runtime first sends a closed, metadata-fenced initialize control to its owned
native child. Its correlated ACK reserves the launcher's requested UUID with
NULL observed fields. It is not an identity or account attestation. Ordinary
owner input is admitted/reserved/consumed once, then written through the actual
provider writer fence. Only matching native `system/init`, persisted by Core,
permits Started and subsequent durable output. Busy/Unavailable retains exact
pending identity/observation; revocation or wrong identity refuses and cleans
only this owned process tree.

Progress/payload and explicit owner acceptance use existing HTTP routes. A
proposal retains the child without spending further I/O authority; acceptance
persists the existing receipt and ends this first-turn factory. A queued followup
is preserved without dispatch. Typed Claude Stop, continuation, accepted restart,
lease renewal and Worker execution remain required follow-up ports. The server
advertises Stop/Steer unavailable and refuses Stop before creating an intent.
Budget/shutdown can durably fence an active run, then quarantine its child, but
leave CancelRequested unresolved; local cleanup is never provider Stopped proof.

Every setup, wait and active step rechecks the current machine session. Shutdown
retains child resources through Runtime's actual reaper. Synthetic actual HTTP
tests use a fixed executable and disposable account/home; they cannot establish
subscription entitlement or actual Claude compatibility. Those require a fresh
independently reviewed immutable package and the already selected account.

Dependencies are Core5fc155926, Runtime282aee64f/204ffbcc5 plus initialization5a5c
and telemetrya5ab prerequisites, and Claude-only broker source356c578af. Shared
transport/reaping/protocol preserve the existing integration implementation;
the complete nine-module Claude inventory hashes those actual bytes.
