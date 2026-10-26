# Provider refusals and model evidence

A Claude native synthetic retry with `isSynthetic` and `refused_message_id`, or
its `model_refusal_fallback` notice, is provider policy evidence. It is never an
owner input. The broker emits one scoped refusal for the current issued input,
drops fallback output, and Runtime records the closed `policy` failure class.
It does not fabricate a native result, successful proposal or Stopped receipt.

Dropping the owned transport starts ordinary cleanup. The conversation retains
the original child accounting even if the task outcome was consumed before
reaping finished. Once actual custody is released, the existing authenticated
reconciliation path can close the window without replay. The existing lease
expiry and manager cleanup checks remain in force. Audited settlement may mark
the underlying run cancelled; its original policy failure stays visible in
exact-run status, the UI and the adapter's single frozen refusal notice.

Schema 72 stores bounded model observations under the exact issued provider
admission, with their own replay keys and sequence. They advance the execution
revision but never the canonical provider event ordinal, dispatch, cancellation,
acceptance, or retirement state. Requested settings are not answering evidence.

Claude `system/init.model` records the initialized model; assistant text records
its native `message.model`; a refusal records its declining model. The Codex
native thread-start/resume model is retained for turns using that default, or
overriding with exactly that native-reported model (Codex sends no settings
update for an unchanged value), and
scoped `model/rerouted` notifications update the model attached to subsequent
assistant output. For a different explicit Codex override, a native
`thread/settings/updated` notification can confirm the model. Codex 0.163
emits that notification only to clients that opted into its experimental API,
which ordinary Deep/Fast channels do not, so such an override remains
unreported. A fresh Fast thread therefore starts with the Fast turn's explicit
model (the same value its dispatch will request, read from the same launch
settings); the native start reply then reports that model and the matching
turn override is confirmed. A resumed thread never names a model. The broker accepts
only the owned thread, a live committed request and a native model matching that
request's override; it strips all other settings and adds the current request
ID. Runtime checks that exact request and thread, and records answering evidence
only when native assistant text follows. A late confirmation cannot overwrite a
native reroute or complete a run. Requested effort is never inferred as observed
effort. An unconfirmed per-turn override, missing native model, or
legacy run remains explicitly unreported. Merely initializing or rerouting is
not evidence that a model answered. Different initialized and answering values
remain distinct in the UI; reply footers use only the exact answering run.

Synthetic tests exercise policy-window cleanup over real HTTP, unknown model
reporting, reroutes, foreign identities, replay stability, and refusal notices.
They do not establish actual provider entitlement or selected-model acceptance.
A real selected-model canary must compare the native answering model with the
intended resolved model and must fail qualification if the CLI falls back.
