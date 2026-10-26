use super::super::observation_tests::input;
use super::super::tests::{setup, Case};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, ProjectInput};
use std::time::Duration;

async fn conversation(f: &Case, name: &str) -> ConversationId {
    f.store
        .create_project(
            &f.owner,
            &ProjectInput {
                client_request_id: format!("project-{name}"),
                name: name.into(),
            },
        )
        .await
        .unwrap()
        .project
        .conversation_id
}
async fn ready_in(f: &Case, c: &ConversationId) -> Binding {
    let roles = f.handle.ensure_role_bindings(&f.owner, c).await.unwrap();
    f.handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.deep.session_id,
            expected_generation: roles.deep.generation,
            native_session_id: format!("synthetic-native-{c}"),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: format!("thread-ready:{c}"),
        })
        .await
        .unwrap()
}
/// Claims the next queued input of `c` and drives its Deep run to running.
async fn start(f: &Case, c: &ConversationId, b: &Binding, key: &str) -> ProviderAdmission {
    let claim = f
        .handle
        .claim_next(&f.owner, c, &b.session_id, Duration::from_secs(60))
        .await
        .unwrap()
        .unwrap();
    let run = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, &format!("run-{key}"))
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&run, &format!("reserve-{key}"))
        .await
        .unwrap()
    else {
        panic!("reserved")
    };
    assert!(matches!(
        f.handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    run.provider
}
async fn owner_input(f: &Case, c: &ConversationId, key: &str) {
    f.store
        .admit(
            &f.owner,
            c,
            &MessageInput {
                client_message_id: key.into(),
                text: format!("synthetic owner input {key}"),
            },
        )
        .await
        .unwrap();
}
/// Running asking turn of `c` from a fresh owner input.
async fn asking_turn(f: &Case, c: &ConversationId, key: &str) -> (Binding, ProviderAdmission) {
    owner_input(f, c, key).await;
    let b = ready_in(f, c).await;
    let p = start(f, c, &b, key).await;
    (b, p)
}
async fn finish(f: &Case, c: &ConversationId, p: &ProviderAdmission, text: &str, key: &str) {
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::Progress(text.into())),
    ] {
        f.handle
            .append_provider_event(&f.owner, p, &input(p, sequence, event))
            .await
            .unwrap();
    }
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            p,
            &input(p, 3, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, c)
        .await
        .unwrap()
        .unwrap()
        .revision;
    f.store
        .accept_execution_authenticated(
            &f.token,
            c,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id.clone(),
                expected_revision: revision,
                request_key: format!("accept-{key}"),
            },
        )
        .await
        .unwrap();
}
async fn grant(f: &Case, c: &ConversationId, targets: Option<Vec<ConversationId>>) -> String {
    f.store
        .issue_thread_ask_grant(&f.token, &f.owner, c, &ThreadAskGrantRequest { targets })
        .await
        .unwrap()
        .grant
}
fn ask(key: &str, target: &ConversationId, text: &str) -> ThreadAskRequest {
    ThreadAskRequest {
        request_key: key.into(),
        target_conversation_id: target.clone(),
        text: text.into(),
    }
}
async fn count(f: &Case, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn messages(f: &Case, c: &ConversationId) -> i64 {
    count(
        f,
        "SELECT count(*) FROM messages WHERE conversation_id=?",
        &c.to_string(),
    )
    .await
}

#[tokio::test]
async fn running_asker_collects_the_answer_exactly_once() {
    let f = setup().await;
    let a = conversation(&f, "Academic").await;
    let b = conversation(&f, "Hosting").await;
    let g = grant(&f, &a, None).await;
    // No running asking turn: refused, audited, nothing admitted.
    assert_eq!(
        f.store
            .create_thread_ask(&g, &a, &ask("q1", &b, "Bedrock access?"))
            .await,
        Err(ResourceError::Conflict("thread_ask_no_running_turn"))
    );
    assert_eq!(messages(&f, &b).await, 0);
    assert_eq!(
        count(
            &f,
            "SELECT count(*) FROM thread_ask_audit WHERE outcome=?",
            "thread_ask_no_running_turn"
        )
        .await,
        1
    );
    let (_, asker) = asking_turn(&f, &a, "owner-a1").await;
    let receipt = f
        .store
        .create_thread_ask(&g, &a, &ask("q1", &b, "Bedrock access?"))
        .await
        .unwrap();
    assert!(receipt.created);
    let id = receipt.ask.ask_id;
    assert_eq!(receipt.ask.state, ThreadAskState::Sent);
    assert_eq!(receipt.ask.target_name, "Hosting");
    assert!(receipt.ask.status_text.contains("not processed yet"));
    // The target input is attributed to the asking thread's agent.
    let text: String = sqlx::query_scalar("SELECT text FROM messages WHERE conversation_id=?")
        .bind(b.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(text.contains("from \"Academic\" (that thread's agent, not the owner)"));
    assert!(text.contains("Bedrock access?"));
    // Exact replay is the same request; a changed body under the key conflicts.
    let replay = f
        .store
        .create_thread_ask(&g, &a, &ask("q1", &b, "Bedrock access?"))
        .await
        .unwrap();
    assert!(!replay.created);
    assert_eq!(replay.ask.ask_id, id);
    assert_eq!(
        f.store
            .create_thread_ask(&g, &a, &ask("q1", &b, "Other text"))
            .await,
        Err(ResourceError::Conflict("thread_ask_conflict"))
    );
    assert_eq!(messages(&f, &b).await, 1);
    // The trusted scheduler queues the target's ordinary Deep turn once.
    let tick = f.handle.advance_thread_asks(true).await.unwrap();
    assert_eq!(tick.queued, 1);
    assert_eq!(f.handle.advance_thread_asks(true).await.unwrap().queued, 0);
    assert_eq!(
        count(
            &f,
            "SELECT count(*) FROM execution_window_queue WHERE input_request_key=?",
            &format!("thread-ask:{id}")
        )
        .await,
        1
    );
    let status = f.store.thread_ask_status(&g, &a, id).await.unwrap();
    assert_eq!(status.state, ThreadAskState::Sent);
    assert_eq!(
        status.detail.as_deref(),
        Some("waiting_for_target_capacity")
    );
    // The target's run for that exact input.
    let bb = ready_in(&f, &b).await;
    let target = start(&f, &b, &bb, "target-b1").await;
    let status = f.store.thread_ask_status(&g, &a, id).await.unwrap();
    assert_eq!(status.state, ThreadAskState::Running);
    assert!(status.status_text.contains("not answered yet"));
    let early = f.store.collect_thread_ask(&g, &a, id).await.unwrap();
    assert_eq!((early.answer, early.returned), (None, None));
    finish(&f, &b, &target, "Bedrock works in eu-central-1.", "b1").await;
    let status = f.store.thread_ask_status(&g, &a, id).await.unwrap();
    assert_eq!(status.state, ThreadAskState::Answered);
    assert_eq!(status.returned, None);
    // The asking turn is still running: the scheduler settles but never routes.
    let tick = f.handle.advance_thread_asks(true).await.unwrap();
    assert_eq!((tick.settled, tick.returned), (1, 0));
    let collected = f.store.collect_thread_ask(&g, &a, id).await.unwrap();
    assert_eq!(
        collected.answer.as_deref(),
        Some("Bedrock works in eu-central-1.")
    );
    assert_eq!(collected.returned, Some(ThreadAskReturn::ToolResult));
    let again = f.store.collect_thread_ask(&g, &a, id).await.unwrap();
    assert_eq!(again.answer, None);
    assert_eq!(again.returned, Some(ThreadAskReturn::ToolResult));
    // Ending the asking turn later never adds a second copy as an input.
    finish(&f, &a, &asker, "done", "a1").await;
    assert_eq!(
        f.handle.advance_thread_asks(true).await.unwrap().returned,
        0
    );
    assert_eq!(messages(&f, &a).await, 1);
    let list = f
        .store
        .thread_asks_for_owner(&f.token, &f.owner, &b, 10)
        .await
        .unwrap();
    assert_eq!(list.asks.len(), 1);
    assert_eq!(list.asks[0].answer, None);
}

#[tokio::test]
async fn ended_asker_receives_one_attributed_reply_input() {
    let f = setup().await;
    let a = conversation(&f, "Academic").await;
    let b = conversation(&f, "Hosting").await;
    let g = grant(&f, &a, Some(vec![b.clone()])).await;
    let (_, asker) = asking_turn(&f, &a, "owner-a1").await;
    let id = f
        .store
        .create_thread_ask(&g, &a, &ask("q1", &b, "Bedrock access?"))
        .await
        .unwrap()
        .ask
        .ask_id;
    finish(&f, &a, &asker, "Sent the request; not answered yet.", "a1").await;
    let bb = ready_in(&f, &b).await;
    let target = start(&f, &b, &bb, "target-b1").await;
    finish(&f, &b, &target, "Use profile hosting-bedrock.", "b1").await;
    let tick = f.handle.advance_thread_asks(true).await.unwrap();
    assert_eq!((tick.settled, tick.returned), (1, 1));
    for _ in 0..2 {
        assert_eq!(
            f.handle.advance_thread_asks(true).await.unwrap().returned,
            0
        );
    }
    let key = format!("thread-ask-reply:{id}");
    let reply: String =
        sqlx::query_scalar("SELECT text FROM messages WHERE conversation_id=? AND request_key=?")
            .bind(a.to_string())
            .bind(&key)
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert!(reply.contains("from \"Hosting\" (that thread's agent, not the owner)"));
    assert!(reply.contains("Use profile hosting-bedrock."));
    assert_eq!(messages(&f, &a).await, 2);
    // The reply input has its own queued Deep turn in the asking conversation.
    assert_eq!(
        count(
            &f,
            "SELECT count(*) FROM execution_window_queue WHERE input_request_key=?",
            &key
        )
        .await,
        1
    );
    let status = f.store.thread_ask_status(&g, &a, id).await.unwrap();
    assert_eq!(status.returned, Some(ThreadAskReturn::Input));
    assert!(status.reply_message_id.is_some());
    assert!(status.status_text.contains("as a new message"));
    // The turn processing the reply cannot collect a second copy; it may ask
    // again at the same depth.
    let ab = f
        .handle
        .ensure_role_bindings(&f.owner, &a)
        .await
        .unwrap()
        .deep;
    let ab = if ab.native_session_id.is_some() {
        ab
    } else {
        ready_in(&f, &a).await
    };
    let _turn = start(&f, &a, &ab, "a2").await;
    let collected = f.store.collect_thread_ask(&g, &a, id).await.unwrap();
    assert_eq!(collected.answer, None);
    let follow = f
        .store
        .create_thread_ask(&g, &a, &ask("q2", &b, "Which region?"))
        .await
        .unwrap();
    assert!(follow.created);
    let depth: i64 = count(
        &f,
        "SELECT depth FROM thread_asks WHERE id=?",
        &follow.ask.ask_id.to_string(),
    )
    .await;
    assert_eq!(depth, 0);
}

#[tokio::test]
async fn failed_or_withdrawn_target_work_returns_an_honest_failure_once() {
    let f = setup().await;
    let a = conversation(&f, "Academic").await;
    let b = conversation(&f, "Hosting").await;
    let g = grant(&f, &a, None).await;
    let (_, asker) = asking_turn(&f, &a, "owner-a1").await;
    let id = f
        .store
        .create_thread_ask(&g, &a, &ask("q1", &b, "Bedrock access?"))
        .await
        .unwrap()
        .ask
        .ask_id;
    let bb = ready_in(&f, &b).await;
    let target = start(&f, &b, &bb, "target-b1").await;
    f.handle
        .append_provider_event(&f.owner, &target, &input(&target, 1, ProviderEvent::Failed))
        .await
        .unwrap();
    let status = f.store.thread_ask_status(&g, &a, id).await.unwrap();
    assert_eq!(status.state, ThreadAskState::Failed);
    assert_eq!(status.detail.as_deref(), Some("target_turn_failed"));
    assert!(status.status_text.contains("did not answer"));
    let collected = f.store.collect_thread_ask(&g, &a, id).await.unwrap();
    assert_eq!(collected.state, ThreadAskState::Failed);
    assert_eq!(collected.answer, None);
    assert_eq!(collected.returned, Some(ThreadAskReturn::ToolResult));
    finish(&f, &a, &asker, "done", "a1").await;
    assert_eq!(
        f.handle.advance_thread_asks(true).await.unwrap().returned,
        0
    );
    assert_eq!(messages(&f, &a).await, 1);
}

#[tokio::test]
async fn failure_after_the_asking_turn_is_returned_as_one_input() {
    let f = setup().await;
    let a = conversation(&f, "Academic").await;
    let b = conversation(&f, "Hosting").await;
    let g = grant(&f, &a, None).await;
    let (_, asker) = asking_turn(&f, &a, "owner-a1").await;
    let id = f
        .store
        .create_thread_ask(&g, &a, &ask("q1", &b, "Bedrock access?"))
        .await
        .unwrap()
        .ask
        .ask_id;
    finish(&f, &a, &asker, "done", "a1").await;
    let bb = ready_in(&f, &b).await;
    let target = start(&f, &b, &bb, "target-b1").await;
    f.handle
        .append_provider_event(&f.owner, &target, &input(&target, 1, ProviderEvent::Failed))
        .await
        .unwrap();
    // Without a window dispatcher nothing is queued, but the outcome still returns.
    let tick = f.handle.advance_thread_asks(false).await.unwrap();
    assert_eq!((tick.queued, tick.settled, tick.returned), (0, 1, 1));
    let reply: String = sqlx::query_scalar("SELECT text FROM messages WHERE request_key=?")
        .bind(format!("thread-ask-reply:{id}"))
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(reply.contains("was not answered: target_turn_failed"));
    assert_eq!(
        f.handle.advance_thread_asks(false).await.unwrap().returned,
        0
    );
}

#[tokio::test]
async fn cross_owner_allowlist_self_rate_and_revocation_are_refused_and_audited() {
    let f = setup().await;
    let a = conversation(&f, "Academic").await;
    let b = conversation(&f, "Hosting").await;
    let c = conversation(&f, "Design").await;
    // A second owner's conversation (production setup is single-owner).
    let foreign_owner = Uuid::new_v4();
    let foreign = ConversationId(Uuid::new_v4());
    let mut conn = f.store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO owners(id,username,password_hash,singleton) VALUES(?,'synthetic-foreign-owner','synthetic-hash',2)")
        .bind(foreign_owner.to_string()).execute(&mut *conn).await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO conversations(id,owner_id) VALUES(?,?)")
        .bind(foreign.to_string())
        .bind(foreign_owner.to_string())
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    // An owner cannot list a foreign conversation as a target.
    assert_eq!(
        f.store
            .issue_thread_ask_grant(
                &f.token,
                &f.owner,
                &a,
                &ThreadAskGrantRequest {
                    targets: Some(vec![foreign.clone()])
                }
            )
            .await
            .err(),
        Some(ResourceError::Conflict("thread_ask_target_not_found"))
    );
    let g = grant(&f, &a, None).await;
    let _turn = asking_turn(&f, &a, "owner-a1").await;
    assert_eq!(
        f.store
            .create_thread_ask(&g, &a, &ask("x1", &foreign, "Hi"))
            .await,
        Err(ResourceError::Conflict("thread_ask_target_not_found"))
    );
    assert_eq!(messages(&f, &foreign).await, 0);
    assert_eq!(
        f.store
            .create_thread_ask(&g, &a, &ask("x2", &a, "Hi"))
            .await,
        Err(ResourceError::Conflict("thread_ask_self"))
    );
    // A grant is scoped to its own conversation.
    assert_eq!(
        f.store
            .create_thread_ask(&g, &b, &ask("x3", &c, "Hi"))
            .await,
        Err(ResourceError::Unauthorized)
    );
    // Rotation retires the old grant; an allowlist limits the targets.
    let limited = grant(&f, &a, Some(vec![b.clone()])).await;
    assert_eq!(
        f.store
            .create_thread_ask(&g, &a, &ask("x4", &b, "Hi"))
            .await,
        Err(ResourceError::Unauthorized)
    );
    assert_eq!(
        f.store
            .create_thread_ask(&limited, &a, &ask("x5", &c, "Hi"))
            .await,
        Err(ResourceError::Conflict("thread_ask_target_not_allowed"))
    );
    let targets = f.store.thread_ask_targets(&limited, &a).await.unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].name, "Hosting");
    // Open requests are bounded.
    for n in 0..THREAD_ASK_OPEN_MAX {
        f.store
            .create_thread_ask(&limited, &a, &ask(&format!("ok{n}"), &b, "Hi"))
            .await
            .unwrap();
    }
    assert_eq!(
        f.store
            .create_thread_ask(&limited, &a, &ask("over", &b, "Hi"))
            .await,
        Err(ResourceError::Conflict("thread_ask_rate_limited"))
    );
    assert_eq!(
        count(
            &f,
            "SELECT count(*) FROM thread_asks WHERE target_conversation_id!=?",
            &b.to_string()
        )
        .await,
        0
    );
    // Every authenticated attempt is in the append-only audit.
    let audited: Vec<String> =
        sqlx::query_scalar("SELECT outcome FROM thread_ask_audit ORDER BY row_sequence")
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(
        audited,
        [
            "thread_ask_target_not_found",
            "thread_ask_self",
            "thread_ask_target_not_allowed",
            "accepted",
            "accepted",
            "accepted",
            "accepted",
            "thread_ask_rate_limited"
        ]
    );
    assert!(sqlx::query("DELETE FROM thread_ask_audit")
        .execute(&f.store.pool)
        .await
        .is_err());
    assert!(
        sqlx::query("UPDATE thread_asks SET target_conversation_id=?")
            .bind(c.to_string())
            .execute(&f.store.pool)
            .await
            .is_err()
    );
    f.store
        .revoke_thread_ask_grant(&f.token, &f.owner, &a)
        .await
        .unwrap();
    assert_eq!(
        f.store.thread_ask_targets(&limited, &a).await,
        Err(ResourceError::Unauthorized)
    );
    let view = f
        .store
        .thread_ask_grant(&f.token, &f.owner, &a)
        .await
        .unwrap();
    assert!(!view.issued);
    assert_eq!(view.generation, 2);
}

#[tokio::test]
async fn request_chains_stop_at_depth_one() {
    let f = setup().await;
    let a = conversation(&f, "Academic").await;
    let b = conversation(&f, "Hosting").await;
    let c = conversation(&f, "Design").await;
    let ga = grant(&f, &a, None).await;
    let gb = grant(&f, &b, None).await;
    let gc = grant(&f, &c, None).await;
    let _turn = asking_turn(&f, &a, "owner-a1").await;
    f.store
        .create_thread_ask(&ga, &a, &ask("q1", &b, "Step one"))
        .await
        .unwrap();
    // Hosting's turn handling that request may ask once more (depth 1).
    let bb = ready_in(&f, &b).await;
    let _b_turn = start(&f, &b, &bb, "b1").await;
    let second = f
        .store
        .create_thread_ask(&gb, &b, &ask("q2", &c, "Step two"))
        .await
        .unwrap();
    assert_eq!(
        count(
            &f,
            "SELECT depth FROM thread_asks WHERE id=?",
            &second.ask.ask_id.to_string()
        )
        .await,
        1
    );
    // Design's turn handling the depth-1 request cannot start another hop.
    let cb = ready_in(&f, &c).await;
    let _c_turn = start(&f, &c, &cb, "c1").await;
    assert_eq!(
        f.store
            .create_thread_ask(&gc, &c, &ask("q3", &a, "Step three"))
            .await,
        Err(ResourceError::Conflict("thread_ask_chain_too_deep"))
    );
}
