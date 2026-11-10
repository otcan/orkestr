# Ordinary Claude first-turn source review

Exact reviewed checkpoint: `4b3c64cd523ebbabe0c8703aeec7c74d85b04b75`.

No blocking finding in the bounded first fresh turn, owner acceptance and owned cleanup composition. This is an independent source review, not independent execution of the supplied HTTP, Store, Runtime or broker tests.

The private configuration selects the provider, retains existing launcher/hash/workspace/current-machine-session checks, refuses Claude Worker policy and budgets over 45 seconds, and refuses existing execution history rather than attempting resume. HTTP input cannot select the provider or supply setup/execution authority. Ordinary claim, admission, reservation and consumed capability attachment remain required.

Protocol initialization reserves requested identity only. The reviewed Runtime/Core observation path persists matching genuine native initialization before publishing Started or subsequent output; transient observation failures retain original identity. The new factory maintains current machine authentication and supervisor heartbeat. Proposal handling neither polls late frames nor claims followup input. Only explicit authenticated owner acceptance completes the first turn. Budget/shutdown cancellation persists an intent before local cleanup and remains unconfirmed; it supplies no native Stopped evidence.

Preparing and live wrappers retain owned child resources through the existing reaper; live wrapper Drop revokes its authority. Joined shutdown waits for the child set and reports unconfirmed reaping. The factory does not enable the control registry for Claude. Stop, reuse, restart, renewal and Worker composition remain outside this gate.

Independent byte checks passed for all nine module hashes in `claude-package.json`. Shared `protocol.py`, `transport.py` and `reaping.py` are byte-identical to the parent of the Claude package import. No provider process, account/profile read, binary execution, rebuild or browser run was performed. Author test counts and immutable artifact qualification remain separately attributed.

The shared exact-scope registry and `install_control` Result ABI integration remain owned by the composition lane; this review does not approve unseen integration changes or grant real selected-account activation.

## Wrong-init fixture race: independent immutable execution

Rust CI `39177661969` at `25b3bbb463bd1e71f7c9f2f8eb72e43348b64b4d` failed the wrong-init branch's transient `starting` assertion at line 96. Its Claude HTTP fixture is byte-identical to the reviewed `4b3c64cd523ebbabe0c8703aeec7c74d85b04b75` fixture. This is the branch corrected by existing fixture-only commit `86029c4f1e116187b48f04efaab7085490a90ed5`, rather than a newly discovered protocol failure.

Independent execution used an exact `25b3` archive of the tests and provider broker with the immutable `4b3` server, independently hashed SHA-256 `4e16b0b663e771bd5337942606c34cc6ff5e9ff98f61cabb89249b4986c87911`. No rebuild or real provider was used. The unchanged fixture passed success then failed the adjacent line 95 zero-observations assertion in wrong-init: cleanup can persist Lost before the subsequent ledger/HTTP reads. The original failure remains preserved; local execution does not claim to have reproduced CI's precise line 96 interleaving.

Replacing only that fixture with exact `86029c4` passed all four supplied cases independently: success, wrong-init, revoked and budget. The correction permits only Starting/Blocked with delivery unknown and zero observations or one Lost. It still requires unobserved requested identity, no progress or acceptance candidate, and disabled Stop/steer; foreign initialization cannot become Started or a completion proposal. The assertions do not require a transient state to survive owned-child reaping.

These are independent executions of supplied synthetic HTTP regressions against immutable `4b3`, not execution of a newly built `25b3` server or hosted successor CI qualification. The coordinator owns adopting the existing fixture correction and observing green successor CI.
