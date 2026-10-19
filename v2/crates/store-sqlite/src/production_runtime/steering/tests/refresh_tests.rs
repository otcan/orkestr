use super::*;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_retains_turn_and_refuses_wrong_previous_or_revoked_context() {
    let (f, a, mut renewal) = running_with_renewal().await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    f.handle.heartbeat_supervisor().await.unwrap();
    let transition = f.handle.renew_running(&mut renewal).await.unwrap();
    let a = f
        .handle
        .refresh_codex_steering(a, &transition)
        .await
        .unwrap();
    assert_eq!(a.provider(), transition.current());
    let req = request(&f, &a, "renewed-steer").await;
    let (_, reservation) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    let SteeringConsumption::Deliver(delivery) = f
        .handle
        .consume_codex_steering(reservation.unwrap())
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(delivery.expected_turn_id(), "native-turn:1");
    assert!(f
        .handle
        .refresh_codex_steering(a, &transition)
        .await
        .is_err());

    let (f, a, mut renewal) = running_with_renewal().await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    f.handle.heartbeat_supervisor().await.unwrap();
    let transition = f.handle.renew_running(&mut renewal).await.unwrap();
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(f
        .handle
        .refresh_codex_steering(a, &transition)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_before_refresh_refuses_without_changing_turn() {
    let (f, a, mut renewal) = running_with_renewal().await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    f.handle.heartbeat_supervisor().await.unwrap();
    let transition = f.handle.renew_running(&mut renewal).await.unwrap();
    let control = request(&f, &a, "stop-before-refresh").await.control;
    f.handle
        .stop_execution_authenticated(&f.token, &f.conversation, &control)
        .await
        .unwrap();
    assert!(f
        .handle
        .refresh_codex_steering(a, &transition)
        .await
        .is_err());
    let turn: String = sqlx::query_scalar("SELECT native_turn_id FROM production_steering_turns")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(turn, "native-turn:1");
}
