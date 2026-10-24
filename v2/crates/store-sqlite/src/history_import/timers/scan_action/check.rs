//! A manual check is an atomic one-shot action on the ordinary scheduler.
//! Negative cancellation is durable even when an interrupted create arrives late.
use super::*;

async fn cancelled(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    key: &str,
) -> Result<bool> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_check_cancellations WHERE owner_id=? AND conversation_id=? AND request_key=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(key)
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    Ok(count == 1)
}

async fn prior(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    key: &str,
) -> Result<Option<SqliteRow>> {
    sqlx::query("SELECT semantic_digest,authority_json,namespace FROM tracker_manual_checks WHERE owner_id=? AND conversation_id=? AND request_key=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(key)
        .fetch_optional(&mut **tx).await.map_err(unavailable)
}

fn decision_digest(request: &TrackerCheckRequest, rules: (&str, &str)) -> String {
    hash(
        &serde_json::json!([
            "orkestr.tracker.manual-check.v1",
            request.expected_source_revision,
            request.expected_recipe,
            rules.0,
            rules.1
        ])
        .to_string(),
    )
}

async fn recover(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    key: &str,
    old: Option<&SqliteRow>,
) -> Result<TrackerCheckReceipt> {
    Ok(TrackerCheckReceipt {
        request_key: key.to_owned(),
        authority: old
            .map(|row| serde_json::from_str(row.get("authority_json")))
            .transpose()
            .map_err(unavailable)?,
        cancelled: cancelled(tx, owner, conversation, key).await?,
        duplicate: true,
    })
}

impl Store {
    /// The trusted runtime supplies the installed deterministic rule identity.
    /// Creating a check does not opt the owner into recurring automation.
    pub async fn create_tracker_check(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &TrackerCheckRequest,
        rules: (&str, &str),
    ) -> Result<TrackerCheckReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        if !valid(&request.request_key, 128) {
            return Err(HistoryError::Invalid);
        }
        let digest = decision_digest(request, rules);
        let old = prior(&mut tx, owner, conversation, &request.request_key).await?;
        if let Some(ref old) = old {
            if old.get::<String, _>("semantic_digest") != digest {
                return Err(HistoryError::Conflict);
            }
            let receipt = recover(
                &mut tx,
                owner,
                conversation,
                &request.request_key,
                Some(old),
            )
            .await?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(receipt);
        }
        if cancelled(&mut tx, owner, conversation, &request.request_key).await? {
            let receipt = recover(&mut tx, owner, conversation, &request.request_key, None).await?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(receipt);
        }
        // Bound live decisions, independently from the runtime's actual I/O slots.
        // A source change revokes old actions; their immutable history stays intact.
        let counts = sqlx::query("SELECT count(*) AS total,COALESCE(sum(c.conversation_id=?),0) AS scoped FROM tracker_manual_checks c JOIN dormant_timers d ON d.owner_id=c.owner_id AND d.namespace=c.namespace JOIN tracker_scan_authorities a ON a.owner_id=d.owner_id AND a.namespace=d.namespace AND a.generation=d.generation JOIN trackers t ON t.owner_id=a.owner_id AND t.conversation_id=a.conversation_id AND t.source_revision=a.source_revision AND t.recipe=a.recipe_id WHERE d.state='enabled' AND NOT EXISTS(SELECT 1 FROM production_stop_boundaries b JOIN events e ON e.id=b.event_id WHERE b.owner_id=a.owner_id AND b.conversation_id=a.conversation_id AND e.sequence>a.stop_sequence)")
            .bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if counts.get::<i64, _>("total") >= 16 || counts.get::<i64, _>("scoped") != 0 {
            return Err(HistoryError::Conflict);
        }
        let now = store_clock(&mut tx).await?;
        let namespace = Uuid::new_v4();
        let due_ms = now.checked_add(1).ok_or(HistoryError::Unavailable)?;
        import::import_in_transaction(
            &mut tx,
            owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "tracker-manual-check".into(),
                source_timer_id: namespace.to_string(),
                source_enabled: false,
                schedule: TimerSchedule::Once { due_ms },
            },
        )
        .await?;
        let authority = enable::enable_in_transaction(
            &mut tx,
            owner,
            &TrackerScanEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: request.request_key.clone(),
                    conversation_id: conversation.clone(),
                },
                expected_source_revision: request.expected_source_revision,
                expected_recipe: request.expected_recipe.clone(),
                classifier_id: rules.0.into(),
                classifier_digest: rules.1.into(),
            },
            now,
        )
        .await?;
        sqlx::query("INSERT INTO tracker_manual_checks(owner_id,conversation_id,request_key,semantic_digest,namespace,authority_json,created_ms) VALUES(?,?,?,?,?,?,?)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .bind(digest).bind(namespace.to_string()).bind(serde_json::to_string(&authority).map_err(unavailable)?).bind(now)
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TrackerCheckReceipt {
            request_key: request.request_key.clone(),
            authority: Some(authority),
            cancelled: false,
            duplicate: false,
        })
    }

    /// Read historical outcome before discovery/readiness. This creates no work.
    pub async fn tracker_check_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
    ) -> Result<TrackerCheckReceipt> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let old = prior(&mut tx, owner, conversation, key).await?;
        let receipt = recover(&mut tx, owner, conversation, key, old.as_ref()).await?;
        if old.is_none() && !receipt.cancelled {
            return Err(HistoryError::NotFound);
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(receipt)
    }

    /// Cancel by client decision key, even if its create has not arrived yet.
    /// This is a negative fence, never evidence that a reader exited.
    pub async fn cancel_tracker_check(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
    ) -> Result<TrackerCheckReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        if !valid(key, 128) {
            return Err(HistoryError::Invalid);
        }
        let old = prior(&mut tx, owner, conversation, key).await?;
        let duplicate = cancelled(&mut tx, owner, conversation, key).await?;
        if !duplicate {
            if let Some(ref old) = old {
                let namespace = Uuid::parse_str(old.get("namespace")).map_err(unavailable)?;
                let current = receipt(&row(&mut tx, owner, namespace).await?)?;
                if current.state == TimerState::Enabled {
                    control::control_in_transaction(
                        &mut tx,
                        owner,
                        &TimerControlRequest {
                            namespace,
                            expected_revision: current.revision,
                            request_key: format!("check-stop:{}", hash(key)),
                            action: TimerControl::Stop,
                        },
                    )
                    .await?;
                }
            }
            let now = store_clock(&mut tx).await?;
            sqlx::query("INSERT INTO tracker_check_cancellations(owner_id,conversation_id,request_key,created_ms) VALUES(?,?,?,?)")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(key).bind(now)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        let mut result = recover(&mut tx, owner, conversation, key, old.as_ref()).await?;
        result.duplicate = duplicate;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
