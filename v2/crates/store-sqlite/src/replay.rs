//! Replay every canonical row as its actual versioned variant.
use super::*;
pub(super) async fn events(
    pool: &SqlitePool,
    owner: &OwnerId,
    conversation: &ConversationId,
    scope: Scope,
    after: i64,
    limit: u32,
) -> Result<Vec<ConversationEvent>> {
    let rows = sqlx::query("SELECT e.*,coalesce(o.run_sequence,p.run_sequence) AS run_sequence,coalesce(o.kind,p.kind) AS observation_kind,o.synthetic,coalesce(o.receipt_state,p.receipt_state) AS receipt_state,c.inflight_status AS cancel_outcome,coalesce(r.id,pr.id) AS run_id,coalesce(r.session_id,pr.session_id) AS session_id,coalesce(r.message_id,pr.message_id) AS source_message_id,coalesce(r.event_id,pr.event_id) AS source_event_id FROM events e LEFT JOIN fixture_observations o ON o.event_id=e.id LEFT JOIN fixture_cancellations c ON c.event_id=e.id LEFT JOIN fixture_runs r ON r.id=coalesce(o.run_id,c.run_id) LEFT JOIN production_observations p ON p.event_id=e.id LEFT JOIN production_runs pr ON pr.id=p.run_id WHERE e.conversation_id=? AND e.owner_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?")
        .bind(conversation.to_string()).bind(owner.to_string()).bind(after).bind(limit.clamp(1,100)).fetch_all(pool).await.map_err(db)?;
    rows.iter()
        .map(|r| {
            let event_id = EventId(parse(r.get("id"))?);
            let sequence = r.get("sequence");
            let occurred_at = r.get("occurred_at");
            match (r.get::<&str, _>("kind"), r.get::<i64, _>("schema_version")) {
                ("message_accepted", 1) => {
                    let message_id = MessageId(parse(r.get("message_id"))?);
                    Ok(ConversationEvent::MessageAccepted(EventEnvelope {
                        event_id,
                        schema_version: 1,
                        owner_id: owner.clone(),
                        scope: scope.clone(),
                        aggregate_id: conversation.clone(),
                        aggregate_version: sequence,
                        sequence,
                        correlation_id: message_id.clone(),
                        causation_id: message_id.clone(),
                        actor_kind: "owner".into(),
                        source: "http".into(),
                        occurred_at,
                        payload_ref_or_safe_payload: MessageAccepted {
                            kind: "message_accepted".into(),
                            message_id,
                        },
                    }))
                }
                ("provider_observed", 5) => {
                    let observation = match r.try_get::<&str, _>("observation_kind").map_err(db)? {
                        "started" => ProductionObservationKind::Started,
                        "approval_requested" => ProductionObservationKind::ApprovalRequested,
                        "completed_proposal" => ProductionObservationKind::CompletedProposal,
                        "failed" => ProductionObservationKind::Failed,
                        "lost" => ProductionObservationKind::Lost,
                        _ => return Err(StoreError::Unavailable),
                    };
                    Ok(ConversationEvent::ProviderObserved(
                        ProviderObservedEnvelope {
                            event_id,
                            schema_version: 5,
                            owner_id: owner.clone(),
                            scope: scope.clone(),
                            aggregate_id: conversation.clone(),
                            aggregate_version: sequence,
                            sequence,
                            occurred_at,
                            source_message_id: MessageId(parse(
                                r.try_get("source_message_id").map_err(db)?,
                            )?),
                            source_event_id: EventId(parse(
                                r.try_get("source_event_id").map_err(db)?,
                            )?),
                            payload_ref_or_safe_payload: ProviderObserved {
                                kind: ProviderObservedTag::ProviderObserved,
                                run_id: RunId(parse(r.try_get("run_id").map_err(db)?)?),
                                session_id: SessionId(parse(r.try_get("session_id").map_err(db)?)?),
                                run_sequence: u64::try_from(
                                    r.try_get::<i64, _>("run_sequence").map_err(db)?,
                                )
                                .map_err(db)?,
                                observation,
                            },
                        },
                    ))
                }
                ("fixture_cancellation_requested", 3) => {
                    let outcome = match r.try_get::<&str, _>("cancel_outcome").map_err(db)? {
                        "not_dispatched" => FixtureCancellationOutcome::NotDispatched,
                        "unknown" => FixtureCancellationOutcome::Unknown,
                        _ => return Err(StoreError::Unavailable),
                    };
                    Ok(ConversationEvent::FixtureCancellationRequested(
                        FixtureCancellationRequestedEnvelope {
                            event_id,
                            schema_version: 3,
                            owner_id: owner.clone(),
                            scope: scope.clone(),
                            aggregate_id: conversation.clone(),
                            aggregate_version: sequence,
                            sequence,
                            occurred_at,
                            source_message_id: MessageId(parse(
                                r.try_get("source_message_id").map_err(db)?,
                            )?),
                            source_event_id: EventId(parse(
                                r.try_get("source_event_id").map_err(db)?,
                            )?),
                            payload_ref_or_safe_payload: FixtureCancellationRequested {
                                kind: FixtureCancellationTag::FixtureCancellationRequested,
                                run_id: RunId(parse(r.try_get("run_id").map_err(db)?)?),
                                session_id: SessionId(parse(r.try_get("session_id").map_err(db)?)?),
                                outcome,
                            },
                        },
                    ))
                }
                ("fixture_provider_stopped", 4) => {
                    if r.try_get::<&str, _>("observation_kind").map_err(db)? != "stopped"
                        || r.try_get::<&str, _>("receipt_state").map_err(db)? != "cancelled"
                    {
                        return Err(StoreError::Unavailable);
                    }
                    Ok(ConversationEvent::FixtureProviderStopped(
                        FixtureProviderStoppedEnvelope {
                            event_id,
                            schema_version: 4,
                            owner_id: owner.clone(),
                            scope: scope.clone(),
                            aggregate_id: conversation.clone(),
                            aggregate_version: sequence,
                            sequence,
                            occurred_at,
                            source_message_id: MessageId(parse(
                                r.try_get("source_message_id").map_err(db)?,
                            )?),
                            source_event_id: EventId(parse(
                                r.try_get("source_event_id").map_err(db)?,
                            )?),
                            payload_ref_or_safe_payload: FixtureProviderStopped {
                                kind: FixtureStoppedTag::FixtureProviderStopped,
                                run_id: RunId(parse(r.try_get("run_id").map_err(db)?)?),
                                session_id: SessionId(parse(r.try_get("session_id").map_err(db)?)?),
                                run_sequence: u64::try_from(
                                    r.try_get::<i64, _>("run_sequence").map_err(db)?,
                                )
                                .map_err(db)?,
                                receipt_state: FixtureStoppedReceiptState::Cancelled,
                            },
                        },
                    ))
                }
                ("fixture_provider_observed", 2) => {
                    let observation = match r.try_get::<&str, _>("observation_kind").map_err(db)? {
                        "started" => FixtureObservationKind::Started,
                        "approval_requested" => FixtureObservationKind::ApprovalRequested,
                        "completed_proposal" => FixtureObservationKind::CompletedProposal {
                            synthetic: r.try_get::<i64, _>("synthetic").map_err(db)? == 1,
                        },
                        "failed" => FixtureObservationKind::Failed,
                        "lost" => FixtureObservationKind::Lost,
                        _ => return Err(StoreError::Unavailable),
                    };
                    Ok(ConversationEvent::FixtureProviderObserved(
                        FixtureProviderObservedEnvelope {
                            event_id,
                            schema_version: 2,
                            owner_id: owner.clone(),
                            scope: scope.clone(),
                            aggregate_id: conversation.clone(),
                            aggregate_version: sequence,
                            sequence,
                            occurred_at,
                            source_message_id: MessageId(parse(
                                r.try_get("source_message_id").map_err(db)?,
                            )?),
                            source_event_id: EventId(parse(
                                r.try_get("source_event_id").map_err(db)?,
                            )?),
                            payload_ref_or_safe_payload: FixtureProviderObserved {
                                kind: FixtureObservationTag::FixtureProviderObserved,
                                run_id: RunId(parse(r.try_get("run_id").map_err(db)?)?),
                                session_id: SessionId(parse(r.try_get("session_id").map_err(db)?)?),
                                run_sequence: u64::try_from(
                                    r.try_get::<i64, _>("run_sequence").map_err(db)?,
                                )
                                .map_err(db)?,
                                observation,
                            },
                        },
                    ))
                }
                _ => Err(StoreError::Unavailable),
            }
        })
        .collect()
}
