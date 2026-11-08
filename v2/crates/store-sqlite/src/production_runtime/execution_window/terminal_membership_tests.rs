//! Locator narrowing preserves both providers, history and owner fencing.
use super::*;

async fn add_scope(
    tx: &mut SqliteConnection,
    owner: &str,
    provider: &str,
    namespace: &str,
    key: &str,
) -> String {
    let context = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,?,?,?,?,1,1)")
        .bind(&context).bind(owner).bind(provider).bind(namespace).bind(key)
        .bind(Uuid::new_v4().to_string()).execute(tx).await.unwrap();
    context
}

async fn members(
    tx: &mut SqliteConnection,
    query: &str,
    owner: &str,
    namespace: &str,
    key: &str,
    conversation: &str,
) -> Vec<String> {
    sqlx::query_scalar(query)
        .bind(owner)
        .bind(namespace)
        .bind(key)
        .bind(conversation)
        .bind(conversation)
        .fetch_all(tx)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scoped_context_locators_preserve_exact_membership_and_duplicate_counts() {
    let (w, _, _, _, _) = root_window().await;
    let config = fixtures::config(ProductionTakeover::First);
    let owner = w.f.owner.to_string();
    let conversation = w.f.conversation.to_string();
    let context = w.f.handle.authority.as_ref().unwrap().id.clone();
    let mut tx = w.f.store.pool.begin().await.unwrap();
    let other = Uuid::new_v4().to_string();
    // Production setup is single-owner. Bypass only that fixture insertion
    // CHECK, restoring all checks before constructing/testing any locators.
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO owners(id,username,password_hash,singleton) VALUES(?,'synthetic-foreign-owner','synthetic-hash',2)")
        .bind(&other).execute(&mut *tx).await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=OFF")
        .execute(&mut *tx)
        .await
        .unwrap();
    let checks: i64 = sqlx::query_scalar("PRAGMA ignore_check_constraints")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(checks, 0);
    // The original context is now discoverable through windows/readiness only.
    sqlx::query(
        "UPDATE production_supervisors SET namespace='window-history-only' WHERE context_id=?",
    )
    .bind(&context)
    .execute(&mut *tx)
    .await
    .unwrap();
    let codex = add_scope(
        &mut tx,
        &owner,
        "codex",
        &config.namespace,
        &config.supervisor_key,
    )
    .await;
    let claude = add_scope(
        &mut tx,
        &owner,
        "claude",
        &config.namespace,
        &config.supervisor_key,
    )
    .await;
    let readiness = add_scope(&mut tx, &owner, "codex", "readiness-only", "old-scope").await;
    sqlx::query("UPDATE production_readiness SET context_id=? WHERE session_id=?")
        .bind(&readiness)
        .bind(w.roles.deep.session_id.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let unrelated = add_scope(&mut tx, &owner, "codex", "other-conversation", "other").await;
    let foreign = add_scope(
        &mut tx,
        &other,
        "codex",
        &config.namespace,
        &config.supervisor_key,
    )
    .await;
    let original = "SELECT s.context_id FROM production_supervisors s WHERE s.owner_id=? AND ((s.namespace=? AND s.supervisor_key=?) OR EXISTS(SELECT 1 FROM execution_windows cw WHERE cw.context_id=s.context_id AND cw.owner_id=s.owner_id AND cw.conversation_id=?) OR EXISTS(SELECT 1 FROM production_readiness cr JOIN session_bindings cb ON cb.id=cr.session_id WHERE cr.context_id=s.context_id AND cb.owner_id=s.owner_id AND cb.conversation_id=?)) ORDER BY s.context_id";
    let narrowed = format!(
        "SELECT s.context_id {} ORDER BY s.context_id",
        crate::production_runtime::execution_window::retired_context::CONVERSATION_SUPERVISORS
    );
    let mut expected = vec![context.clone(), codex.clone(), claude, readiness];
    expected.sort();
    for query in [original, narrowed.as_str()] {
        let rows = members(
            &mut tx,
            query,
            &owner,
            &config.namespace,
            &config.supervisor_key,
            &conversation,
        )
        .await;
        assert_eq!(rows, expected);
        assert!(!rows.contains(&unrelated));
        assert!(!rows.contains(&foreign));
    }
    // One context reached by both direct and historical locators is still
    // counted once; only locators are deduplicated, not retirement evidence.
    sqlx::query("UPDATE execution_windows SET context_id=? WHERE id=?")
        .bind(&codex).bind(w.status.window_id.to_string())
        .execute(&mut *tx).await.unwrap();
    expected.retain(|item| item != &context);
    for query in [original, narrowed.as_str()] {
        assert_eq!(members(&mut tx, query, &owner, &config.namespace, &config.supervisor_key, &conversation).await, expected);
    }
    // Even malformed cross-owner locators cannot smuggle another owner's
    // supervisor into a same-owner conversation membership set.
    sqlx::query("UPDATE execution_windows SET context_id=? WHERE id=?")
        .bind(foreign)
        .bind(w.status.window_id.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let a = members(
        &mut tx,
        original,
        &owner,
        &config.namespace,
        &config.supervisor_key,
        &conversation,
    )
    .await;
    let b = members(
        &mut tx,
        &narrowed,
        &owner,
        &config.namespace,
        &config.supervisor_key,
        &conversation,
    )
    .await;
    assert_eq!(a, b);
    tx.rollback().await.unwrap();
}
