# Used-workflow and migration checkpoint

This supplements the source baseline in ../parity-inventory.md and reconciles
against ../full-release.md's current web-first scope. iOS deferral does not waive
web or currently used specialist workflow gates. No count establishes non-use.
Private observations and actual counts remain outside OSS.

| Full-release obligation | Actual evidence | Remaining blocking acceptance/dependency |
|---|---|---|
| Primary conversations / workers / provider runtime | Reviewed live structural thread aggregates; persisted roles, runtime class, lifecycle and binding-object shape | Activity, effective grants and end-to-end provider parity remain separate runtime/UI evidence. |
| Job/project/task / approval / effect history | Reviewed live table and fixed run-state/provider/trigger aggregates | Empty engine tables cannot eliminate other authorities. Paused task/approval/effect import contracts absent; no uncertain effects replay. |
| Personal memory and consent | Exact reviewed personal_memory count receipt consumed privately, including actual counts | Count gives neither content portability nor consent. No external-memory coverage or deletion-aware import contract. |
| Independent timers | Reviewed fixed structural parser and completed private live registry count receipt; synthetic refusal tests | Persisted enabled/status/cadence fields do not prove firing or effective normalized state. No timer import/paused apply port. |
| Binding and connector workflows | Primary thread binding-object presence only | Effective capability/held route inventory incomplete. Session binding registries excluded. Never migrate active routes or sessions. |
| Mail/calendar / specialist tools / OXRM | Existing code establishes feature surfaces; Gmail account GET excluded because it migrates credentials | Need inert authoritative selectors and retained external-tool acceptance. Excluded selector is not an absent feature. No credential/profile inspection. |
| Durable ordinary history transfer | Actual registered Store stable export to fresh-owner dormant import, reopen, replay/conflict/auth refusal, rollback and native-delta export checks | One conversation only. Legacy multi-authority consistent exporter and reviewed scope mapping still absent. |
| Crash and rollback recovery | Synthetic child exits without destructors before ledger commit and after acknowledged import; reopen/integrity/FK checks | Before-commit case exercises a real ledger transaction, not a fault injected inside import_history. Storage/power-loss and all instruction-boundary crash acceptance unexecuted. |
| Preserve V2-only delta on return | Synthetic native message survives dormant rollback; schema-20 recovery cut captures inactive ledger and native delta, and atomic two-history-batch restore/rollback tests pass | Typed single-Store recovery only. JSON-to-Store bundle adapter, registered API, recovery SIGKILL acceptance and reverse legacy import remain incomplete. External-effect reconciliation is separate. |

## Timer structural selector source review

Deployed generic source: packages/storage/src/paths.js::dataPaths defines only
home/timers.json for this authority. repositories.js::createTimerRepository.list
calls ensureDataDirs then reads that JSON array; the new reader calls neither.
packages/core/src/timers.js::normalizeStoredTimer defines cadence, enabled, status,
targetType, requiredConnector/requiredDesktop and legacy/repeat handling. Parser
reports exact raw known values and missing/unknown buckets, without imitating
normalization, deriving next-run time or opening referenced files. It does not
read user timer registries, API session bindings, routes or connector secrets.

Reader opens one fixed file under the reviewed home via directory fd, O_NOFOLLOW
and read-only flags; bounds size/rows; rejects aliases/nonregular files, duplicate
keys and malformed JSON; checks fd/path identity and change metadata. Output keys
are fixed. Unknown raw strings, IDs, prompts, paths, connector names and identities
are never returned. One stable-metadata file read is not cross-store consistency.
Concurrent mutation tests verify refusal; filesystem timestamp guarantees do not
constitute an atomic scheduler snapshot.

The private live personal_memory and timer receipts were consumed and coverage
reconciled privately. Timer execution used refreshed runtime selectors and the
reviewed fixed reader, without initialization. Persisted structure does not prove
current scheduling activity, capability availability or cross-authority coherence.

## Concrete next migration dependencies

1. Effective timer and binding capabilities still need authoritative inert metadata
   and workflow acceptance; completed structural counts cannot establish parity.
2. Core/authority-owned consistent legacy thread/history export, explicit owner and
   scope mapping, and separate approval/effect/resource/timer dormant ports. Counts
   and a single V2 conversation export cannot substitute for these.
3. Integrate and independently review schema-20 typed recovery capture/restore and
   bundle rollback. Complete the JSON-to-Store adapter, recovery process-crash
   acceptance and reverse legacy reconciliation; synthetic typed Store tests do
   not establish a production or legacy recovery path.
4. Per-workflow owner acceptance of effective bindings, mail/calendar, memory and
   OXRM; source feature presence and aggregate counts are insufficient for cutover.

Main messaging mute/holds and personal skill-only router/autostart exclusion stay
intact. No production mutation, credential copy, activation, dispatcher or cutover
is authorized by this checkpoint.
