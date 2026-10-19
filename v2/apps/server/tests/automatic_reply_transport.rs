//! Real ordinary Store capabilities and fake owned Unix sockets; no registration.
#[path = "../src/automatic_reply_transport.rs"]
mod automatic_reply_transport;
#[path = "automatic_reply_transport/fixture.rs"]
mod fixture;
use automatic_reply_transport::*;
use fixture::Case;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{AutomaticReplyHoldReason, AutomaticReplySendState};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::Duration,
};

async fn start(
    c: &Case,
    output: &[u8],
    socket: UnixStream,
) -> Result<ReplyStart, TransportFailure> {
    reserve_and_consume(
        &c.bound,
        &c.token,
        &c.producer,
        FrozenReply {
            input_id: c.input,
            request_key: "reply:1",
            output,
        },
        socket,
    )
    .await
}
fn pair() -> (UnixStream, UnixStream) {
    let (a, b) = UnixStream::pair().unwrap();
    b.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    (a, b)
}
fn eof(mut peer: UnixStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    peer.read_to_end(&mut bytes).unwrap();
    bytes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_frozen_bytes_once_and_full_write_stays_unknown() {
    let c = Case::new(true).await;
    let (socket, peer) = pair();
    let mut bytes = b"frozen synthetic reply".to_vec();
    let ReplyStart::Writing(mut writer) = start(&c, &bytes, socket).await.unwrap() else {
        panic!()
    };
    bytes.fill(b'x'); // no caller substitution after Core consumed the snapshot
    assert_eq!(
        writer.step(3).unwrap(),
        WriteProgress::Pending { written_bytes: 3 }
    );
    while writer.step(4).unwrap() != WriteProgress::ReadyToFinish {}
    let receipt = writer.finish().await.unwrap();
    assert_eq!(receipt.state, AutomaticReplySendState::DeliveryUnknown);
    assert_eq!(receipt.written_bytes, 22);
    assert_eq!(eof(peer), b"frozen synthetic reply");
    let (socket, peer) = pair();
    let ReplyStart::Replay(replay) = start(&c, b"frozen synthetic reply", socket).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(replay, receipt);
    assert!(eof(peer).is_empty());
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn default_disabled_closes_without_native_bytes() {
    let c = Case::new(false).await;
    let (socket, peer) = pair();
    assert!(matches!(
        start(&c, b"synthetic", socket).await,
        Err(TransportFailure::Store(RuntimeStoreError::Fenced))
    ));
    assert!(eof(peer).is_empty());
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disable_hold_replacement_and_revoke_refuse_every_actual_suffix() {
    for mode in 0..4 {
        for prefix in [0, 3] {
            let c = Case::new(true).await;
            let (socket, peer) = pair();
            let ReplyStart::Writing(mut writer) =
                start(&c, b"synthetic reply", socket).await.unwrap()
            else {
                panic!()
            };
            if prefix > 0 {
                assert_eq!(
                    writer.step(prefix).unwrap(),
                    WriteProgress::Pending {
                        written_bytes: prefix
                    }
                );
            }
            match mode {
                0 => c.permission(false, 1, "disable").await,
                1 => c
                    .store
                    .hold_automatic_reply_input_authenticated(
                        &c.token,
                        &c.conversation,
                        c.input,
                        AutomaticReplyHoldReason::OperatorPreserved,
                    )
                    .await
                    .unwrap(),
                2 => {
                    c.bound
                        .bind_automatic_reply_route(
                            &c.token,
                            &c.conversation,
                            c.producer.route_id(),
                            "synthetic-other-account",
                            c.producer.route_generation(),
                        )
                        .await
                        .unwrap();
                }
                _ => c.store.revoke_session(&c.token).await.unwrap(),
            }
            assert!(matches!(writer.step(4), Err(TransportFailure::Store(_))));
            assert!(matches!(writer.step(4), Err(TransportFailure::Closed)));
            assert_eq!(eof(peer), b"synthetic reply"[..prefix]);
            assert!(writer.finish().await.is_err());
            c.cleanup().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peer_failure_poisons_closes_and_cannot_reissue() {
    let c = Case::new(true).await;
    let (socket, peer) = pair();
    drop(peer);
    let ReplyStart::Writing(mut writer) = start(&c, b"synthetic", socket).await.unwrap() else {
        panic!()
    };
    let Err(TransportFailure::Socket(error)) = writer.step(4) else {
        panic!()
    };
    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
    ));
    assert!(matches!(writer.step(4), Err(TransportFailure::Closed)));
    let (socket, peer) = pair();
    let ReplyStart::Replay(receipt) = start(&c, b"synthetic", socket).await.unwrap() else {
        panic!()
    };
    assert_eq!(receipt.state, AutomaticReplySendState::DeliveryUnknown);
    assert_eq!(receipt.written_bytes, 0);
    assert!(eof(peer).is_empty());
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_wouldblock_is_zero_known_bytes_then_resumes_exact_suffix() {
    let c = Case::new(true).await;
    let (mut socket, mut peer) = pair();
    socket.set_nonblocking(true).unwrap();
    // Fill only this synthetic endpoint before transferring it, to force EAGAIN.
    let filler = [b'z'; 4096];
    let mut filled = 0;
    loop {
        match socket.write(&filler) {
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            other => panic!("unexpected fill {other:?}"),
        }
    }
    let ReplyStart::Writing(mut writer) = start(&c, b"synthetic", socket).await.unwrap() else {
        panic!()
    };
    assert_eq!(
        writer.step(4).unwrap(),
        WriteProgress::Pending { written_bytes: 0 }
    );
    let mut prior = vec![0; filled];
    peer.read_exact(&mut prior).unwrap();
    assert!(prior.iter().all(|b| *b == b'z'));
    assert_eq!(writer.step(16384).unwrap(), WriteProgress::ReadyToFinish);
    assert_eq!(writer.finish().await.unwrap().written_bytes, 9);
    assert_eq!(eof(peer), b"synthetic");
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn early_finish_and_drop_never_write_remaining_bytes() {
    for finish in [false, true] {
        let c = Case::new(true).await;
        let (socket, peer) = pair();
        let ReplyStart::Writing(mut writer) = start(&c, b"synthetic", socket).await.unwrap() else {
            panic!()
        };
        writer.step(2).unwrap();
        if finish {
            assert!(writer.finish().await.is_err());
        } else {
            drop(writer);
        }
        assert_eq!(eof(peer), b"sy");
        let (socket, peer) = pair();
        assert!(matches!(
            start(&c, b"synthetic", socket).await.unwrap(),
            ReplyStart::Replay(_)
        ));
        assert!(eof(peer).is_empty());
        c.cleanup().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_bytes_then_disabled_finish_stays_unknown_without_reissue() {
    let c = Case::new(true).await;
    let (socket, peer) = pair();
    let ReplyStart::Writing(mut writer) = start(&c, b"synthetic", socket).await.unwrap() else {
        panic!()
    };
    assert_eq!(writer.step(16384).unwrap(), WriteProgress::ReadyToFinish);
    c.permission(false, 1, "disable").await;
    assert!(matches!(
        writer.finish().await,
        Err(TransportFailure::Store(_))
    ));
    assert_eq!(eof(peer), b"synthetic");
    c.permission(true, 2, "enable-again").await;
    let (socket, peer) = pair();
    let ReplyStart::Replay(receipt) = start(&c, b"synthetic", socket).await.unwrap() else {
        panic!()
    };
    assert_eq!(receipt.state, AutomaticReplySendState::DeliveryUnknown);
    assert_eq!(receipt.written_bytes, 9);
    assert!(eof(peer).is_empty());
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_step_limit_is_terminal_without_any_write() {
    for limit in [0, 16385] {
        let c = Case::new(true).await;
        let (socket, peer) = pair();
        let ReplyStart::Writing(mut writer) = start(&c, b"synthetic", socket).await.unwrap() else {
            panic!()
        };
        assert!(matches!(
            writer.step(limit),
            Err(TransportFailure::Store(RuntimeStoreError::InvalidInput))
        ));
        assert!(matches!(writer.step(1), Err(TransportFailure::Closed)));
        assert!(eof(peer).is_empty());
        c.cleanup().await;
    }
}
