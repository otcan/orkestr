# Canonical conversation replay compatibility

ConversationEvent is an untagged wire union, distinguished by schema_version and
payload kind, not a wrapper around the existing event. MessageAccepted(EventEnvelope)
serializes exactly as before: schema_version 1, message_accepted payload, existing
SSE name message_accepted. Existing event.json is unchanged.

FixtureProviderObserved uses schema_version 2 and SSE name
fixture_provider_observed. Its metadata envelope carries the same canonical
owner/scope/conversation/event/sequence/time fields, separate typed
source_message_id/source_event_id, and typed run/session/run sequence plus an
observation kind. Only CompletedProposal carries synthetic. No message correlation
or causation is fabricated; native identities, credentials, lease/fence/dispatch
locators and raw progress are absent. See fixture-provider-observed.json.

Deserialize replay through ConversationEvent: unknown fields, mismatched variant
schema/kind, missing synthetic and invalid typed IDs are rejected. IntakeStore::events
returns this union; SSE uses each variant's name and the canonical sequence cursor.
No journal rows are filtered. The current store still only writes legacy intake
rows; fixture persistence follows separately after the additive migration.
