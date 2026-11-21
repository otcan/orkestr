//! The owner's Stop of a running Deep turn while a native-attach hold is
//! active (`orkestr attach --interrupt`): the run is cancelled, but no Stop
//! boundary holds the queued inputs, because the hold already queues them and
//! they run after release. Without the hold a Stop is unchanged.
use super::tests::{claim, ready, setup};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionControlRequest, ExecutionStopOutcome, MessageInput};

async fn rows(store: &Store, table: &str, conversation: &str) -> i64 {
    let statement = format!("SELECT count(*) FROM {table} WHERE conversation_id=?");
    sqlx::query_scalar(&statement)
        .bind(conversation)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_owner_stop_during_a_hold_cancels_without_holding_inputs_and_otherwise_holds_them() {
    for hold_inputs in [false, true] {
        let f = setup().await;
        let b = ready(&f).await;
        let c = claim(&f, &b).await;
        let run = f
            .handle
            .admit_run(&c, &b.session_id, b.generation, "attach-stop")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = f
            .handle
            .claim_provider_dispatch(&run, "reserve")
            .await
            .unwrap()
        else {
            panic!("reservation refused")
        };
        let ExecutionConsumption::Dispatch(_) =
            f.handle.consume_execution(&reservation).await.unwrap()
        else {
            panic!("consumption refused")
        };
        let p = &run.provider;
        let event = |p: &ProviderAdmission, sequence, event| ProviderEventInput {
            run_id: p.run.run_id.clone(),
            session_id: p.run.session_id.clone(),
            sequence,
            lease_generation: p.run.lease_generation,
            dispatch_fence: p.run.dispatch_fence,
            event,
        };
        f.handle
            .append_provider_event(&f.owner, p, &event(p, 1, ProviderEvent::Started))
            .await
            .unwrap();
        // An owner message queues behind the running turn.
        let follow_up = f
            .store
            .admit(
                &f.owner,
                &f.conversation,
                &MessageInput {
                    client_message_id: "follow-up-while-attached".into(),
                    text: "synthetic follow-up".into(),
                },
            )
            .await
            .unwrap()
            .receipt;
        let status = f
            .handle
            .execution_run_status(&f.token, &f.owner, &f.conversation, &p.run.run_id)
            .await
            .unwrap()
            .unwrap();
        let request = ExecutionControlRequest {
            run_id: p.run.run_id.clone(),
            expected_revision: status.revision,
            expected_control_revision: status.control_revision,
            request_key: "attach-interrupt".into(),
        };
        let (receipt, cancel) = f
            .handle
            .stop_execution_control_authenticated_holding(
                &f.token,
                &f.conversation,
                &request,
                hold_inputs,
            )
            .await
            .unwrap();
        assert_eq!(receipt.outcome, ExecutionStopOutcome::RequestedUnknown);
        let mut stopped = p.clone();
        stopped.run = cancel.new_fenced_admission;
        f.handle
            .append_provider_event(
                &f.owner,
                &stopped,
                &event(&stopped, 2, ProviderEvent::Stopped),
            )
            .await
            .unwrap();
        let conversation = f.conversation.to_string();
        let boundaries = rows(&f.store, "production_stop_boundaries", &conversation).await;
        let held = rows(&f.store, "production_held_inputs", &conversation).await;
        let page = f
            .handle
            .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 10)
            .await
            .unwrap();
        if hold_inputs {
            // Unchanged: the Stop cuts the queue and holds the follow-up.
            assert_eq!(boundaries, 1);
            assert!(held >= 1);
            assert!(page
                .held
                .iter()
                .any(|input| input.message_id == follow_up.message_id));
            assert!(!page.eligible_input_available);
        } else {
            // Held by the terminal: no boundary, nothing held, still eligible.
            assert_eq!((boundaries, held), (0, 0));
            assert!(page.held.is_empty());
            assert!(page.eligible_input_available, "it runs after release");
        }
        // A replay keeps the first request's decision.
        let (replay, _) = f
            .handle
            .stop_execution_control_authenticated_holding(
                &f.token,
                &f.conversation,
                &request,
                !hold_inputs,
            )
            .await
            .unwrap();
        assert_eq!(replay, receipt);
        assert_eq!(
            rows(&f.store, "production_stop_boundaries", &conversation).await,
            boundaries
        );
    }
}
