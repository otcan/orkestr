# Claude protocol initialization

The closed metadata codec sends only `control_request` with request ID
`initialize:2` and request `{subtype: initialize, hooks: null}`. Broker request 2
must be prepared before any actual provider write. Each actual suffix uses the
owned metadata child's current Core metadata fence; no provider response wait
belongs inside that transaction.

The sanitized correlated success response has only `type: control_response`
and `response: {subtype: success, request_id: initialize:2}`. Account, model,
capability and process payloads are rejected by the Runtime codec. A partial
write or uncertain fenced outcome cannot be retried as a fresh request.

This establishes protocol initialization only. It does not establish native
session identity, subscription authorization, Started, or completion. The
existing `PreparingClaude` native-confirmation path is not connected to this
codec: Core must first supply the distinct requested-native reservation and
protocol-initialized issuer. Actual matching `system/init` after consumed
input must be independently validated and persisted before Started. Never
fabricate system/init or feed this ACK to native confirmation.
