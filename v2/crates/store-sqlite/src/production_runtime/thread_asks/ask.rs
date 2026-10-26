//! Grant holder side: targets, send, status and collect.
use super::*;

/// The asking run's context depth: 0 for an owner input; one more than the
/// request it answers, or than the request whose returned outcome it handles.
async fn context_depth(tx: &mut SqliteConnection, owner: &OwnerId, message: &str) -> R<i64> {
    let parent: Option<i64> = sqlx::query_scalar("SELECT depth FROM thread_asks WHERE owner_id=?2 AND (input_message_id=?1 OR reply_message_id=?1)")
        .bind(message).bind(owner.to_string())
        .fetch_optional(tx).await.map_err(unavailable)?;
    Ok(parent.map_or(0, |depth| depth + 1))
}

impl Store {
    /// Conversations this grant may ask, with their names.
    pub async fn thread_ask_targets(
        &self,
        grant: &str,
        conversation: &ConversationId,
    ) -> R<Vec<ThreadAskTarget>> {
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, false).await?;
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT c.id,coalesce(d.name,'Assistant') FROM conversations c LEFT JOIN conversation_directory d ON d.conversation_id=c.id WHERE c.owner_id=?1 AND c.id!=?2 AND NOT EXISTS(SELECT 1 FROM restricted_threads r WHERE r.conversation_id=c.id AND r.enabled=1) AND NOT EXISTS(SELECT 1 FROM whatsapp_chat_provisions p WHERE p.owner_id=c.owner_id AND p.conversation_id=c.id AND p.archived=1) ORDER BY d.name,c.id LIMIT 500")
            .bind(caller.owner.to_string()).bind(conversation.to_string())
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let mut result = Vec::new();
        for (id, name) in rows {
            let id = ConversationId(uuid(&id)?);
            if caller.targets.as_ref().is_none_or(|t| t.contains(&id)) {
                result.push(ThreadAskTarget {
                    conversation_id: id,
                    name: label(&name),
                });
            }
        }
        Ok(result)
    }

    /// Record one request and admit it as the target's attributed input.
    /// `dispatcher` says whether a window dispatcher will start the target's
    /// turn; without one the request is refused rather than left unprocessed.
    /// A request key replays only within the same running asking turn.
    /// Refusals are audited (bounded per conversation) and change nothing else.
    pub async fn create_thread_ask(
        &self,
        grant: &str,
        conversation: &ConversationId,
        request: &ThreadAskRequest,
        dispatcher: bool,
    ) -> R<ThreadAskReceipt> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        // Read-only first: the refusal budget and an exact replay need no lock.
        {
            let (mut tx, caller) = self.thread_ask_scope(grant, conversation, false).await?;
            let refused: i64 = sqlx::query_scalar("SELECT count(*) FROM thread_ask_audit WHERE source_conversation_id=? AND outcome!='accepted' AND at_ms>?")
                .bind(conversation.to_string()).bind(now_ms() - 600_000)
                .fetch_one(&mut *tx).await.map_err(unavailable)?;
            if refused >= THREAD_ASK_REFUSALS_MAX {
                return Err(ResourceError::Conflict("thread_ask_rate_limited"));
            }
            let running = running_deep(&mut tx, &caller.owner, conversation).await?;
            if let Some((run, _)) = &running {
                if let Some(row) = sqlx::query("SELECT * FROM thread_asks WHERE owner_id=? AND source_conversation_id=? AND source_run_id=? AND request_key=?")
                    .bind(caller.owner.to_string()).bind(conversation.to_string()).bind(run).bind(&request.request_key)
                    .fetch_optional(&mut *tx).await.map_err(unavailable)? {
                    if row.get::<String, _>("target_conversation_id") == request.target_conversation_id.to_string()
                        && row.get::<String, _>("text_digest") == crate::digest(&request.text)
                    {
                        let ask = view(&mut tx, &row, None).await?;
                        tx.commit().await.map_err(unavailable)?;
                        return Ok(ThreadAskReceipt { created: false, ask });
                    }
                }
            }
            tx.commit().await.map_err(unavailable)?;
        }
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, true).await?;
        let owner = caller.owner.clone();
        let target = request.target_conversation_id.to_string();
        let digest = crate::digest(&request.text);
        let running = running_deep(&mut tx, &owner, conversation).await?;
        let run = running.as_ref().map(|(run, _)| run.as_str());
        let existing = match run {
            Some(run) => sqlx::query("SELECT target_conversation_id,text_digest FROM thread_asks WHERE owner_id=? AND source_conversation_id=? AND source_run_id=? AND request_key=?")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(run).bind(&request.request_key)
                .fetch_optional(&mut *tx).await.map_err(unavailable)?,
            None => None,
        };
        let refusal = if existing.is_some() {
            // Same run, same key, different body (an exact replay returned above).
            Some("thread_ask_conflict")
        } else if request.target_conversation_id == *conversation {
            Some("thread_ask_self")
        } else if caller
            .targets
            .as_ref()
            .is_some_and(|t| !t.contains(&request.target_conversation_id))
        {
            Some("thread_ask_target_not_allowed")
        } else if owned(&mut tx, &owner, &request.target_conversation_id)
            .await
            .is_err()
        {
            // Another owner's conversation is indistinguishable from none.
            Some("thread_ask_target_not_found")
        } else if unavailable_conversation(&mut tx, &owner, &conversation.to_string()).await? {
            Some("thread_ask_conversation_unavailable")
        } else if unavailable_conversation(&mut tx, &owner, &target).await? {
            Some("thread_ask_target_unavailable")
        } else if running.is_none() {
            Some("thread_ask_no_running_turn")
        } else if !dispatcher {
            Some("thread_ask_no_dispatcher")
        } else {
            None
        };
        let depth = match &running {
            Some((_, message)) => context_depth(&mut tx, &owner, message).await?,
            None => 0,
        };
        // The target is itself waiting on this conversation: asking back would deadlock.
        let cycle: i64 = sqlx::query_scalar("SELECT count(*) FROM thread_asks WHERE owner_id=? AND source_conversation_id=? AND target_conversation_id=? AND return_path IS NULL")
            .bind(owner.to_string()).bind(&target).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        let open: i64 = sqlx::query_scalar("SELECT count(*) FROM thread_asks WHERE owner_id=? AND source_conversation_id=? AND return_path IS NULL")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        let hourly: i64 = sqlx::query_scalar("SELECT count(*) FROM thread_ask_audit WHERE source_conversation_id=? AND outcome='accepted' AND at_ms>?")
            .bind(conversation.to_string()).bind(now_ms() - 3_600_000)
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        let refusal = refusal.or(if depth > THREAD_ASK_MAX_DEPTH {
            Some("thread_ask_chain_too_deep")
        } else if cycle != 0 {
            Some("thread_ask_cycle")
        } else if open >= THREAD_ASK_OPEN_MAX || hourly >= THREAD_ASK_HOURLY_MAX {
            Some("thread_ask_rate_limited")
        } else {
            None
        });
        if let Some(code) = refusal {
            audit(
                &mut tx,
                &owner,
                conversation,
                run,
                caller.generation,
                request,
                None,
                code,
            )
            .await?;
            tx.commit().await.map_err(unavailable)?;
            return Err(ResourceError::Conflict(code));
        }
        let run = run.ok_or(ResourceError::Unavailable)?.to_owned();
        let ask = Uuid::new_v4();
        let source_name = name(&mut tx, &conversation.to_string()).await?;
        let input = MessageInput {
            client_message_id: format!("thread-ask:{ask}"),
            text: request_text(&source_name, ask, &request.text),
        };
        let admitted = crate::intake::admit_in_transaction(
            &mut tx,
            &owner,
            &request.target_conversation_id,
            &input,
        )
        .await
        .map_err(|_| ResourceError::Unavailable)?;
        if admitted.duplicate {
            return Err(ResourceError::Unavailable);
        }
        sqlx::query("INSERT INTO thread_asks(id,owner_id,source_conversation_id,source_run_id,grant_generation,request_key,target_conversation_id,text_digest,depth,input_message_id,input_event_id,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(ask.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&run)
            .bind(caller.generation).bind(&request.request_key).bind(&target).bind(&digest).bind(depth)
            .bind(admitted.receipt.message_id.to_string()).bind(admitted.receipt.event_id.to_string())
            .bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        audit(
            &mut tx,
            &owner,
            conversation,
            Some(&run),
            caller.generation,
            request,
            Some(&ask.to_string()),
            "accepted",
        )
        .await?;
        let row = ask_row(&mut tx, &ask.to_string()).await?;
        let ask = view(&mut tx, &row, None).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskReceipt { created: true, ask })
    }

    /// Read-only status of one request sent by this conversation.
    pub async fn thread_ask_status(
        &self,
        grant: &str,
        conversation: &ConversationId,
        ask: Uuid,
    ) -> R<ThreadAskView> {
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, false).await?;
        let row = own_row(&mut tx, &caller, conversation, ask).await?;
        let result = view(&mut tx, &row, None).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Return a settled outcome to the running asking turn. The first collect
    /// fixes `tool_result` for that run; the same run may collect again while
    /// it runs (a lost response loses nothing). Any other turn gets no answer:
    /// the view says how the outcome was returned. Nothing is written until
    /// there is a real transition.
    pub async fn collect_thread_ask(
        &self,
        grant: &str,
        conversation: &ConversationId,
        ask: Uuid,
    ) -> R<ThreadAskView> {
        let run = {
            let (mut tx, caller) = self.thread_ask_scope(grant, conversation, false).await?;
            let row = own_row(&mut tx, &caller, conversation, ask).await?;
            let (run, _) = running_deep(&mut tx, &caller.owner, conversation)
                .await?
                .ok_or(ResourceError::Conflict("thread_ask_no_running_turn"))?;
            let pending = row.get::<Option<String>, _>("outcome").is_none()
                && decision(&mut tx, &row).await?.is_none();
            if pending || returned(&row).is_some() {
                let answer = answer_for(&row, &run);
                let result = view(&mut tx, &row, answer).await?;
                tx.commit().await.map_err(unavailable)?;
                return Ok(result);
            }
            tx.commit().await.map_err(unavailable)?;
            run
        };
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, true).await?;
        let row = own_row(&mut tx, &caller, conversation, ask).await?;
        settle(&mut tx, &row).await?;
        sqlx::query("UPDATE thread_asks SET return_path='tool_result',collected_run_id=?,returned_ms=? WHERE id=? AND outcome IS NOT NULL AND return_path IS NULL")
            .bind(&run).bind(now_ms()).bind(ask.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let row = ask_row(&mut tx, &ask.to_string()).await?;
        let answer = answer_for(&row, &run);
        let result = view(&mut tx, &row, answer).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}

async fn own_row(
    tx: &mut SqliteConnection,
    caller: &Caller,
    conversation: &ConversationId,
    ask: Uuid,
) -> R<SqliteRow> {
    sqlx::query("SELECT * FROM thread_asks WHERE id=? AND owner_id=? AND source_conversation_id=?")
        .bind(ask.to_string())
        .bind(caller.owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(tx)
        .await
        .map_err(unavailable)?
        .ok_or(ResourceError::NotFound)
}
/// The answer only for the run that holds the tool-result return.
fn answer_for(row: &SqliteRow, run: &str) -> Option<String> {
    (row.get::<Option<&str>, _>("return_path") == Some("tool_result")
        && row.get::<Option<&str>, _>("collected_run_id") == Some(run)
        && row.get::<Option<&str>, _>("outcome") == Some("answered"))
    .then(|| render_answer(row.get::<Option<&str>, _>("answer_text")))
}
