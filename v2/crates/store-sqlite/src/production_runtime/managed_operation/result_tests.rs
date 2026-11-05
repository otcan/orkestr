use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixed_result_release_is_one_write_and_revalidated_after_completion() {
    let (_f, bound, token, parent, source) = fixture().await;
    let ManagedOperationConsumption::Operation(operation) = bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    let result = bound
        .complete_managed_operation(&token, operation, ManagedOperationOutcome::Submitted)
        .await
        .unwrap();
    let expected = json!({"state":"completed","result":{"kind":"protected_root_intake","request_id":result.id().to_string(),
        "owner_approval":false,"owner_delivery":"unconfirmed"}});
    assert_eq!(
        result.root_request()["result_sha256"],
        crate::digest(&serde_json::to_string(&expected).unwrap())
    );
    assert!(bound
        .with_managed_result_fence(&token, &result, || Err::<usize, _>(()))
        .unwrap()
        .is_err());
    assert!(bound
        .with_managed_result_fence(&token, &result, || -> std::result::Result<usize, ()> {
            panic!("unknown release cannot retry")
        })
        .is_err());
    let ManagedOperationConsumption::Operation(second) = bound
        .consume_managed_operation(&token, &parent, Uuid::new_v4(), &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    let second = bound
        .complete_managed_operation(&token, second, ManagedOperationOutcome::Submitted)
        .await
        .unwrap();
    sqlx::query("UPDATE production_runs SET state='cancel_requested' WHERE id=?")
        .bind(parent.parent.run.run_id.to_string())
        .execute(&bound.pool)
        .await
        .unwrap();
    assert!(bound
        .with_managed_result_fence(&token, &second, || -> std::result::Result<usize, ()> {
            panic!("durable Stop forbids positive release")
        })
        .is_err());
}
