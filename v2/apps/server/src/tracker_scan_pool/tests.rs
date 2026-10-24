use super::*;

#[tokio::test]
async fn retrying_an_old_action_cancel_does_not_cancel_newer_reader_custody() {
    let pool = ScanPool::new(1, 1).unwrap();
    let (owner, conversation) = ids();
    let action = uuid::Uuid::new_v4();
    let reservation = pool.reserve_action(&owner, &conversation, action).unwrap();
    pool.cancel_action(&owner, &conversation, uuid::Uuid::new_v4());
    assert_eq!(pool.status().cancelled, 0);
    pool.cancel_action(&owner, &conversation, action);
    assert_eq!(pool.status().cancelled, 1);
    assert!(matches!(
        pool.reserve(&owner, &conversation),
        Err(Refused::Busy)
    ));
    drop(reservation);
    assert_eq!(pool.status().cancelled, 0);
    stop(&pool).await;
}
use uuid::Uuid;
fn ids() -> (OwnerId, ConversationId) {
    (OwnerId(Uuid::new_v4()), ConversationId(Uuid::new_v4()))
}
fn empty() -> ScanOutput {
    ScanOutput {
        envelopes: vec![],
        cursor: Cursor::default(),
        stats: Default::default(),
    }
}
fn deadline() -> tokio::time::Instant {
    tokio::time::Instant::now() + Duration::from_secs(2)
}
async fn stop(pool: &ScanPool) {
    pool.begin_shutdown();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !pool.try_join() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(pool.status().occupied, 0);
}
fn blocked(
    pool: &ScanPool,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> (ScanTicket, mpsc::Sender<()>) {
    let reservation = pool.reserve(owner, conversation).unwrap();
    let (entered, started) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let ticket = pool
        .enqueue(reservation, move || {
            assert!(std::thread::current()
                .name()
                .unwrap()
                .starts_with("orkestr-mail-reader-"));
            entered.send(()).unwrap();
            released.recv().unwrap();
            Ok(empty())
        })
        .unwrap();
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    (ticket, release)
}

#[tokio::test]
async fn dropping_or_timing_out_waiter_keeps_reader_custody_until_actual_exit() {
    for timeout in [false, true] {
        let pool = ScanPool::new(1, 2).unwrap();
        let (owner, conversation) = ids();
        let (ticket, release) = blocked(&pool, &owner, &conversation);
        if timeout {
            assert!(matches!(
                ticket.wait(tokio::time::Instant::now()).await,
                Err(ReadFailure::Cancelled)
            ));
        } else {
            drop(ticket);
        }
        assert!(matches!(
            pool.reserve(&owner, &conversation),
            Err(Refused::Busy)
        ));
        assert_eq!((pool.status().occupied, pool.status().active), (1, 1));
        pool.begin_shutdown();
        assert!(!pool.try_join(), "cancellation isn't a join witness");
        release.send(()).unwrap();
        stop(&pool).await;
    }
}

#[tokio::test]
async fn completed_result_holds_slot_through_caller_commit_and_full_pool_refuses() {
    let pool = ScanPool::new(1, 1).unwrap();
    let (owner, conversation) = ids();
    let reservation = pool.reserve(&owner, &conversation).unwrap();
    let other = ids();
    assert!(matches!(
        pool.reserve(&other.0, &other.1),
        Err(Refused::Full)
    ));
    let ticket = pool.enqueue(reservation, || Ok(empty())).unwrap();
    let completion = ticket.wait(deadline()).await.unwrap();
    assert!(completion.result().is_ok());
    assert_eq!((pool.status().occupied, pool.status().active), (1, 0));
    assert!(
        !completion._custody.cancel.load(Ordering::Acquire),
        "successful waiter isn't cancellation"
    );
    assert!(matches!(
        pool.reserve(&owner, &conversation),
        Err(Refused::Busy)
    ));
    drop(completion);
    let next = pool.reserve(&owner, &conversation).unwrap();
    drop(next);
    assert_eq!(pool.status().refusals, 2);
    stop(&pool).await;
}

#[tokio::test]
async fn queued_cancellation_never_starts_another_read_and_queue_is_bounded() {
    let pool = ScanPool::new(1, 2).unwrap();
    let (owner, first) = ids();
    let second = ConversationId(Uuid::new_v4());
    let (ticket, release) = blocked(&pool, &owner, &first);
    let ran = Arc::new(AtomicBool::new(false));
    let observed = ran.clone();
    let queued = pool
        .enqueue(pool.reserve(&owner, &second).unwrap(), move || {
            observed.store(true, Ordering::Release);
            Ok(empty())
        })
        .unwrap();
    assert_eq!(
        (
            pool.status().occupied,
            pool.status().active,
            pool.status().queued
        ),
        (2, 1, 1)
    );
    assert!(matches!(
        pool.reserve(&owner, &ConversationId(Uuid::new_v4())),
        Err(Refused::Full)
    ));
    drop(queued);
    assert!(matches!(pool.reserve(&owner, &second), Err(Refused::Busy)));
    release.send(()).unwrap();
    let completed = ticket.wait(deadline()).await.unwrap();
    drop(completed);
    stop(&pool).await;
    assert!(!ran.load(Ordering::Acquire));
}

#[tokio::test]
async fn panic_is_a_failed_result_with_real_completion_and_worker_survives() {
    let pool = ScanPool::new(1, 1).unwrap();
    let (owner, conversation) = ids();
    let ticket = pool
        .enqueue(
            pool.reserve(&owner, &conversation).unwrap(),
            || -> Result<ScanOutput, ReadFailure> { panic!("synthetic reader panic") },
        )
        .unwrap();
    let completed = ticket.wait(deadline()).await.unwrap();
    assert!(matches!(completed.result(), Err(ReadFailure::Panicked)));
    drop(completed);
    let ticket = pool
        .enqueue(pool.reserve(&owner, &conversation).unwrap(), || Ok(empty()))
        .unwrap();
    assert!(ticket.wait(deadline()).await.unwrap().result().is_ok());
    stop(&pool).await;
}

#[tokio::test]
async fn reservation_is_scoped_to_its_pool_and_shutdown_refuses_new_work() {
    assert!(matches!(ScanPool::new(0, 1), Err(Refused::Invalid)));
    let pool = ScanPool::new(1, 1).unwrap();
    let other = ScanPool::new(1, 1).unwrap();
    let (owner, conversation) = ids();
    let reservation = pool.reserve(&owner, &conversation).unwrap();
    assert!(matches!(
        other.enqueue(reservation, || Ok(empty())),
        Err(Refused::Invalid)
    ));
    assert_eq!(pool.status().occupied, 0);
    let reservation = pool.reserve(&owner, &conversation).unwrap();
    pool.begin_shutdown();
    assert!(matches!(
        pool.enqueue(reservation, || Ok(empty())),
        Err(Refused::Stopping)
    ));
    assert!(matches!(
        pool.reserve(&owner, &conversation),
        Err(Refused::Stopping)
    ));
    stop(&pool).await;
    stop(&other).await;
}

#[tokio::test]
async fn production_submit_reads_only_the_selected_synthetic_mail_store() {
    let root = std::env::temp_dir().join(format!("tracker-reader-pool-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("Inbox");
    let bytes=b"From sender@example.test Sat Oct 24 12:00:00 2026\nMessage-ID: <synthetic-pool@example.test>\nFrom: sender@example.test\nTo: owner@example.test\nDate: Sat, 24 Oct 2026 12:00:00 +0000\nSubject: Synthetic application\n\nSynthetic body.\n";
    std::fs::write(&path, bytes).unwrap();
    let pool = ScanPool::new(1, 1).unwrap();
    let (owner, conversation) = ids();
    let request = ReadRequest {
        profile: root.clone(),
        folders: vec![ScanFolder {
            folder: orkestr_v2_mail_reader::store::MailFolder::Mbox(path.clone()),
            outgoing: true,
        }],
        cursor: Cursor::default(),
        limits: ScanLimits {
            settle_ms: 0,
            ..Default::default()
        },
        now: SystemTime::now(),
    };
    let completion = pool
        .submit(pool.reserve(&owner, &conversation).unwrap(), request)
        .unwrap()
        .wait(deadline())
        .await
        .unwrap();
    let output = completion.result().unwrap();
    assert_eq!(output.envelopes.len(), 1);
    assert!(output.envelopes[0].outgoing);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    drop(completion);
    stop(&pool).await;
    std::fs::remove_dir_all(root).unwrap();
}
