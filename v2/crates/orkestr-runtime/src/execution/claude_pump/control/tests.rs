//! Ordinary Store, private broker and actual native descriptor; no account calls.
use super::*;
use orkestr_v2_contracts::ExecutionPhase;
use std::time::{Duration, Instant};
mod fixture;
use fixture::{pause, Case};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_stop_actual_terminal_and_original_reap_precede_cancelled() {
    for mode in ["success", "terminal-first", "burst"] {
        let mut case = Case::new(mode).await;
        let issued = case.cancel().await;
        let mut stopping = case
            .pump
            .take()
            .unwrap()
            .into_stopping(case.bound.clone(), &issued)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !stopping.stopped() {
            stopping.flush().unwrap();
            stopping.step(&case.bound).await.unwrap();
            if !stopping.stopped() {
                assert_eq!(case.phase().await, ExecutionPhase::CancelRequested);
            }
            pause(deadline).await;
        }
        assert!(stopping.acknowledged());
        assert!(case.gone());
        assert_eq!(case.phase().await, ExecutionPhase::Cancelled);
        assert_eq!(
            std::fs::read(case.root.join("workspace/interrupts")).unwrap(),
            b"one\n"
        );
        let proof = stopping.into_reaped().unwrap();
        assert_eq!(proof.scope().run(), case.run.to_string());
        assert_eq!(
            case.bound
                .request_cancel(&case.owner, &case.run, "owner-stop")
                .await
                .unwrap(),
            issued
        );
        let held = case
            .bound
            .held_owner_inputs_authenticated(&case.token, &case.conversation, 0, 100)
            .await
            .unwrap();
        assert_eq!(held.held.len(), 1);
        assert!(!held.eligible_input_available);
        case.cleanup().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_stop_ack_only_stays_unknown_even_after_cleanup() {
    let mut case = Case::new("ack-only").await;
    let issued = case.cancel().await;
    let mut stopping = case
        .pump
        .take()
        .unwrap()
        .into_stopping(case.bound.clone(), &issued)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !stopping.acknowledged() {
        stopping.flush().unwrap();
        stopping.step(&case.bound).await.unwrap();
        pause(deadline).await;
    }
    for _ in 0..20 {
        stopping.step(&case.bound).await.unwrap();
        pause(deadline).await;
    }
    assert!(!stopping.stopped());
    assert!(!case.gone());
    assert_eq!(case.phase().await, ExecutionPhase::CancelRequested);
    assert!(stopping.into_reaped().is_err());
    assert_eq!(case.phase().await, ExecutionPhase::CancelRequested);
    case.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_stop_foreign_duplicate_and_exit_never_become_stopped() {
    for mode in ["foreign", "duplicate", "exit-only"] {
        let mut case = Case::new(mode).await;
        let issued = case.cancel().await;
        let mut stopping = case
            .pump
            .take()
            .unwrap()
            .into_stopping(case.bound.clone(), &issued)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if stopping.flush().is_err() || stopping.step(&case.bound).await.is_err() {
                break;
            }
            assert!(!stopping.stopped());
            pause(deadline).await;
        }
        assert!(!stopping.stopped());
        assert_eq!(case.phase().await, ExecutionPhase::CancelRequested);
        assert!(stopping.into_reaped().is_err());
        case.cleanup().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_stop_revocation_fences_zero_and_partial_actual_native_suffixes() {
    for prefix in [0usize, 3] {
        let mut case = Case::new("success").await;
        let issued = case.cancel().await;
        let mut stopping = case
            .pump
            .take()
            .unwrap()
            .into_stopping(case.bound.clone(), &issued)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while stopping.writing.is_none() {
            stopping.flush().unwrap();
            stopping.step(&case.bound).await.unwrap();
            pause(deadline).await;
        }
        let before = case.bytes();
        if prefix != 0 {
            let child = stopping.child.as_ref().unwrap();
            assert!(!stopping
                .writing
                .as_mut()
                .unwrap()
                .write(&mut stopping.channel, |bytes| child
                    .write_cancellation_suffix(
                        &stopping.scope,
                        &stopping.fence,
                        &bytes[..prefix]
                    ))
                .unwrap());
            while case.bytes().len() != before.len() + prefix {
                pause(deadline).await;
            }
        }
        case.store.revoke_session(&case.token).await.unwrap();
        assert!(stopping.step(&case.bound).await.is_err());
        assert_eq!(case.bytes().len(), before.len() + prefix);
        assert!(!case.root.join("workspace/interrupts").exists());
        assert_eq!(case.phase().await, ExecutionPhase::CancelRequested);
        assert!(stopping.into_reaped().is_err());
        case.cleanup().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_stop_busy_after_reap_retains_exact_event_without_resending() {
    use std::{
        io::{BufRead, Write},
        process::{Command, Stdio},
    };
    let mut case = Case::new("success").await;
    let issued = case.cancel().await;
    let mut stopping = case
        .pump
        .take()
        .unwrap()
        .into_stopping(case.bound.clone(), &issued)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while stopping.retiring.is_none() {
        stopping.flush().unwrap();
        stopping.step(&case.bound).await.unwrap();
        pause(deadline).await;
    }
    let mut lock=Command::new("/usr/bin/python3").arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('ready',flush=True); sys.stdin.readline(); c.rollback()")
        .arg(case.root.join("state.sqlite3")).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(lock.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "ready");
    loop {
        match stopping.step(&case.bound).await {
            Err(supervisor::Error::Store(
                RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
            )) => break,
            Ok(_) => pause(deadline).await,
            Err(error) => panic!("unexpected {error:?}"),
        }
    }
    assert!(case.gone());
    assert!(stopping.reaped.is_some());
    assert!(stopping.pending().is_some());
    assert!(!stopping.stopped());
    assert_eq!(case.phase().await, ExecutionPhase::CancelRequested);
    let pending = stopping.pending().unwrap().clone();
    let bytes = case.bytes();
    lock.stdin.take().unwrap().write_all(b"release\n").unwrap();
    assert!(lock.wait().unwrap().success());
    // Commit while deliberately losing the receipt, then reconcile the original
    // pending event. The native writer is already closed and cannot be retried.
    case.bound
        .append_provider_event(&case.owner, stopping.fence.control(), &pending)
        .await
        .unwrap();
    stopping.step(&case.bound).await.unwrap();
    assert!(stopping.stopped());
    assert_eq!(case.bytes(), bytes);
    assert!(stopping.into_reaped().is_ok());
    case.cleanup().await;
}
