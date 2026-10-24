//! Atomic recurring action factory and revision-checked negative controls.
use super::*;
use orkestr_v2_contracts::tracker_automation::*;

async fn checked_source(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    source_revision: i64,
) -> Result<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tracker_manual_checks c JOIN tracker_scan_receipts r ON r.owner_id=c.owner_id AND r.conversation_id=c.conversation_id AND r.namespace=c.namespace JOIN tracker_scan_authorities a ON a.authority_id=c.authority_id AND a.owner_id=c.owner_id AND a.namespace=r.namespace AND a.generation=r.generation WHERE c.owner_id=? AND c.conversation_id=? AND a.source_revision=?)")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(source_revision)
        .fetch_one(&mut **tx).await.map_err(unavailable)
}

pub(super) async fn state(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<TrackerAutomationStatus> {
    let source_revision: i64 = sqlx::query_scalar(
        "SELECT source_revision FROM trackers WHERE owner_id=? AND conversation_id=?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(unavailable)?;
    let first_check_complete = checked_source(tx, owner, conversation, source_revision).await?;
    let old = sqlx::query("SELECT revision,authority_json,calendar_json FROM tracker_automation_settings WHERE owner_id=? AND conversation_id=?")
        .bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut **tx).await.map_err(unavailable)?;
    let Some(old) = old else {
        return Ok(TrackerAutomationStatus {
            first_check_complete,
            revision: 0,
            enabled: false,
            source_current: false,
            timer_revision: None,
            authority: None,
            calendar: None,
        });
    };
    let authority: Option<TrackerScanAuthority> = old
        .get::<Option<String>, _>("authority_json")
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(unavailable)?;
    let calendar = old
        .get::<Option<String>, _>("calendar_json")
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(unavailable)?;
    let mut result = TrackerAutomationStatus {
        first_check_complete,
        revision: old.get("revision"),
        enabled: false,
        source_current: false,
        timer_revision: None,
        authority,
        calendar,
    };
    if let Some(ref authority) = result.authority {
        let timer = receipt(&row(tx, owner, authority.namespace).await?)?;
        result.timer_revision = Some(timer.revision);
        let source: Option<i64> = sqlx::query_scalar("SELECT source_revision FROM trackers WHERE owner_id=? AND conversation_id=? AND recipe=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&authority.recipe_id).fetch_optional(&mut **tx).await.map_err(unavailable)?;
        result.source_current = source == Some(authority.source_revision);
        let current_stop = match input::guard(
            tx,
            owner,
            timer.namespace,
            authority.generation,
            conversation,
        )
        .await
        {
            Ok(()) => true,
            Err(HistoryError::Conflict) => false,
            Err(error) => return Err(error),
        };
        result.enabled = timer.state == TimerState::Enabled
            && timer.generation == authority.generation
            && result.source_current
            && current_stop;
    }
    Ok(result)
}
pub(super) async fn prior(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    key: &str,
    digest: Option<&str>,
) -> Result<Option<TrackerAutomationReceipt>> {
    let old = sqlx::query("SELECT semantic_digest,receipt_json FROM tracker_automation_decisions WHERE owner_id=? AND conversation_id=? AND request_key=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(key).fetch_optional(&mut **tx).await.map_err(unavailable)?;
    old.map(|row| {
        if digest.is_some_and(|d| row.get::<String, _>("semantic_digest") != d) {
            return Err(HistoryError::Conflict);
        }
        let mut receipt: TrackerAutomationReceipt =
            serde_json::from_str(row.get("receipt_json")).map_err(unavailable)?;
        receipt.duplicate = true;
        Ok(receipt)
    })
    .transpose()
}
async fn stop_old(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    before: &TrackerAutomationStatus,
) -> Result<()> {
    let Some(ref authority) = before.authority else {
        return Ok(());
    };
    let timer = receipt(&row(tx, owner, authority.namespace).await?)?;
    if !matches!(timer.state, TimerState::Stopped | TimerState::RolledBack) {
        control::control_in_transaction(
            tx,
            owner,
            &TimerControlRequest {
                namespace: timer.namespace,
                expected_revision: timer.revision,
                request_key: format!("automation-replace:{}", timer.revision),
                action: TimerControl::Stop,
            },
        )
        .await?;
    }
    Ok(())
}
async fn persist(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    result: &TrackerAutomationReceipt,
    calendar: Option<&CalendarRule>,
    digest: &str,
    now: i64,
) -> Result<()> {
    let authority = result
        .authority
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(unavailable)?;
    let calendar = calendar
        .map(serde_json::to_string)
        .transpose()
        .map_err(unavailable)?;
    sqlx::query("INSERT INTO tracker_automation_settings(owner_id,conversation_id,revision,authority_json,calendar_json) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,conversation_id) DO UPDATE SET revision=excluded.revision,authority_json=excluded.authority_json,calendar_json=excluded.calendar_json")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(result.revision).bind(authority).bind(calendar).execute(&mut **tx).await.map_err(unavailable)?;
    sqlx::query("INSERT INTO tracker_automation_decisions(owner_id,conversation_id,request_key,semantic_digest,receipt_json,created_ms) VALUES(?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(&result.request_key).bind(digest)
        .bind(serde_json::to_string(result).map_err(unavailable)?).bind(now).execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}

impl Store {
    pub async fn enable_tracker_automation(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &TrackerAutomationEnable,
        rules: (&str, &str),
    ) -> Result<TrackerAutomationReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        let digest = hash(
            &serde_json::json!([
                "tracker.automation.enable.v1",
                request.expected_revision,
                request.expected_timer_revision,
                request.expected_source_revision,
                request.expected_recipe,
                request.calendar,
                request.acknowledge_automation,
                request.expected_classifier_id,
                request.expected_classifier_digest
            ])
            .to_string(),
        );
        if let Some(old) = prior(
            &mut tx,
            owner,
            conversation,
            &request.request_key,
            Some(&digest),
        )
        .await?
        {
            tx.commit().await.map_err(unavailable)?;
            return Ok(old);
        }
        if !valid(&request.request_key, 128)
            || !request.acknowledge_automation
            || request.expected_revision < 0
        {
            return Err(HistoryError::Invalid);
        }
        schedule::encode(&TimerSchedule::Calendar(request.calendar.clone()))?;
        if request.expected_classifier_id != rules.0
            || request.expected_classifier_digest != rules.1
        {
            return Err(HistoryError::Conflict);
        }
        let before = state(&mut tx, owner, conversation).await?;
        if before.revision != request.expected_revision
            || before.timer_revision != request.expected_timer_revision
        {
            return Err(HistoryError::Conflict);
        }
        if !checked_source(
            &mut tx,
            owner,
            conversation,
            request.expected_source_revision,
        )
        .await?
        {
            return Err(HistoryError::Conflict);
        }
        stop_old(&mut tx, owner, &before).await?;
        let active: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_scan_authorities a JOIN dormant_timers t ON t.owner_id=a.owner_id AND t.namespace=a.namespace AND t.generation=a.generation WHERE a.owner_id=? AND t.state='enabled'")
            .bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if active >= 256 {
            return Err(HistoryError::Conflict);
        }
        let now = store_clock(&mut tx).await?;
        let namespace = Uuid::new_v4();
        import::import_in_transaction(
            &mut tx,
            owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "tracker-automation".into(),
                source_timer_id: namespace.to_string(),
                source_enabled: false,
                schedule: TimerSchedule::Calendar(request.calendar.clone()),
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
        let result = TrackerAutomationReceipt {
            request_key: request.request_key.clone(),
            revision: revision(before.revision)?,
            enabled: true,
            authority: Some(authority),
            duplicate: false,
        };
        persist(
            &mut tx,
            owner,
            conversation,
            &result,
            Some(&request.calendar),
            &digest,
            now,
        )
        .await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    /// Even an initial disable at revision zero advances the settings fence,
    /// preventing an old uncertain enable from arriving after the owner's Stop.
    pub async fn disable_tracker_automation(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &TrackerAutomationDisable,
    ) -> Result<TrackerAutomationReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        let digest = hash(
            &serde_json::json!([
                "tracker.automation.disable.v1",
                request.expected_revision,
                request.expected_timer_revision
            ])
            .to_string(),
        );
        if let Some(old) = prior(
            &mut tx,
            owner,
            conversation,
            &request.request_key,
            Some(&digest),
        )
        .await?
        {
            tx.commit().await.map_err(unavailable)?;
            return Ok(old);
        }
        if !valid(&request.request_key, 128) || request.expected_revision < 0 {
            return Err(HistoryError::Invalid);
        }
        let before = state(&mut tx, owner, conversation).await?;
        if before.revision != request.expected_revision
            || before.timer_revision != request.expected_timer_revision
        {
            return Err(HistoryError::Conflict);
        }
        stop_old(&mut tx, owner, &before).await?;
        let now = store_clock(&mut tx).await?;
        let result = TrackerAutomationReceipt {
            request_key: request.request_key.clone(),
            revision: revision(before.revision)?,
            enabled: false,
            authority: before.authority,
            duplicate: false,
        };
        persist(
            &mut tx,
            owner,
            conversation,
            &result,
            before.calendar.as_ref(),
            &digest,
            now,
        )
        .await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    pub async fn tracker_automation_status(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<TrackerAutomationStatus> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let result = state(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    pub async fn tracker_automation_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
    ) -> Result<TrackerAutomationReceipt> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let result = prior(&mut tx, owner, conversation, key, None)
            .await?
            .ok_or(HistoryError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
