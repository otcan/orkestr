use super::*;

#[test]
fn nonblocking_bounded_write_and_echo_preserve_one_jsonl_frame() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let bounds = TransportBounds {
        io_bytes_per_poll: 3,
        ..TransportBounds::default()
    };
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import sys; print(sys.stdin.readline().rstrip('\\n'),flush=True)",
            bounds,
        )
        .spawn(&scope)
        .unwrap();
    child.enqueue_metadata(&scope, &metadata()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let flush = child.flush_stdin(&scope).unwrap();
        assert!(flush.written <= 3);
        if flush.pending_frames == 0 {
            break;
        }
        assert!(Instant::now() < deadline);
    }
    assert_eq!(frame(&child, &scope).unwrap(), metadata());
    assert_eq!(exit(&child, &scope).code, Some(0));
}

#[test]
fn output_overflow_and_truncated_eof_fail_closed() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    for (code, error) in [
        (
            "import sys; sys.stdout.write('x'*100); sys.stdout.flush()",
            Error::FrameTooLarge,
        ),
        (
            "import sys; sys.stdout.write('partial'); sys.stdout.flush()",
            Error::TruncatedFrame,
        ),
    ] {
        let bounds = TransportBounds {
            max_frame_bytes: 16,
            ..TransportBounds::default()
        };
        let child = fixture
            .executor(&authority, &scope, code, bounds)
            .spawn(&scope)
            .unwrap();
        assert_eq!(frame(&child, &scope), Err(error));
        assert_eq!(child.poll_stdout(&scope), Err(Error::PipeClosed));
    }
}

#[test]
fn revoke_fences_live_child_and_never_signals_unrelated_child() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let (other_authority, _) = super::authority(&scope);
    let first = fixture
        .executor(
            &authority,
            &scope,
            "print('ready',flush=True); import time; time.sleep(10)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    let other = fixture
        .executor(
            &other_authority,
            &scope,
            "print('ready',flush=True); import time; time.sleep(10)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert_eq!(frame(&first, &scope).unwrap(), b"ready");
    assert_eq!(frame(&other, &scope).unwrap(), b"ready");
    authority.revoke().unwrap();
    assert_eq!(first.poll_stdout(&scope), Err(Error::Revoked));
    assert_eq!(
        first.enqueue_metadata(&scope, &metadata()),
        Err(Error::Revoked)
    );
    assert_eq!(other.poll_exit(&scope).unwrap(), None);
    other.signal(&scope, Signal::Terminate).unwrap();
    assert_eq!(exit(&other, &scope).signal, Some(15));
}

#[test]
fn exit_observation_keeps_group_owned_until_drop() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "raise SystemExit(7)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert_eq!(exit(&child, &scope).code, Some(7));
    assert_eq!(exit(&child, &scope).code, Some(7)); // WNOWAIT, not reaped.
    child.signal(&scope, Signal::Kill).unwrap(); // Still the owned reserved group.
    authority.revoke().unwrap();
}

#[test]
fn inherited_nonstdio_descriptors_are_closed_on_exec() {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let path = fixture.0.join("synthetic-private-descriptor");
    fs::write(&path, b"synthetic-only").unwrap();
    let file = fs::File::open(&path).unwrap();
    // SAFETY: fixture-owned live fd; clear FD_CLOEXEC to model a host resource.
    assert_eq!(unsafe { fcntl(file.as_raw_fd(), 2, 0) }, 0);
    let child = fixture.executor(&authority, &scope,
        "import os,json; print(json.dumps([os.readlink('/proc/self/fd/'+x) for x in os.listdir('/proc/self/fd') if os.path.exists('/proc/self/fd/'+x)]),flush=True)",
        TransportBounds::default()).spawn(&scope).unwrap();
    let descriptors = String::from_utf8(frame(&child, &scope).unwrap()).unwrap();
    assert!(!descriptors.contains("synthetic-private-descriptor"));
}

#[test]
fn group_revocation_stops_descendant_even_after_leader_exit() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    // Descendant remains in our new process group and holds stdout open.
    // Its bounded synthetic sleep touches no host state.
    let code = "import os,time; pid=os.fork(); print('ready' if pid==0 else 'leader',flush=True); time.sleep(10) if pid==0 else None";
    let child = fixture
        .executor(&authority, &scope, code, TransportBounds::default())
        .spawn(&scope)
        .unwrap();
    let mut seen = Vec::new();
    for _ in 0..2 {
        seen.push(frame(&child, &scope).unwrap());
    }
    assert!(seen.contains(&b"ready".to_vec()));
    assert_eq!(exit(&child, &scope).code, Some(0));
    child.signal(&scope, Signal::Kill).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.poll_stdout(&scope).unwrap() {
            Output::Eof => break, // All inherited group stdout writers closed.
            Output::Pending => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
            Output::Frame(_) => panic!("unexpected extra synthetic frame"),
        }
    }
}

#[test]
fn duplicate_json_keys_are_canonicalized_before_forwarding() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import sys; print(sys.stdin.readline().rstrip('\\n'),flush=True)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    let bytes = br#"{"id":1,"method":"turn/start","method":"account/read","params":{"refreshToken":false}}"#;
    child.enqueue_metadata(&scope, bytes).unwrap();
    child.flush_stdin(&scope).unwrap();
    assert_eq!(frame(&child, &scope).unwrap(), metadata());
}

#[test]
fn all_setup_frames_pass_but_configuration_overrides_do_not() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import time; time.sleep(10)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    for value in [
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"synthetic"},"capabilities":{"experimentalApi":false}}}),
        json!({"method":"initialized"}),
        json!({"id":2,"method":"account/read","params":{"refreshToken":false}}),
        json!({"id":3,"method":"thread/start","params":{"cwd":fixture.0.join("workspace"),"approvalPolicy":"never","sandbox":"read-only","ephemeral":false}}),
    ] {
        child
            .enqueue_metadata(&scope, &serde_json::to_vec(&value).unwrap())
            .unwrap();
    }
    let override_request = json!({"id":4,"method":"thread/start","params":{"cwd":fixture.0.join("workspace"),"approvalPolicy":"never","sandbox":"read-only","ephemeral":false,"config":{"networkAccess":true}}});
    assert_eq!(
        child.enqueue_metadata(&scope, &serde_json::to_vec(&override_request).unwrap()),
        Err(Error::InvalidFrame)
    );
}

#[test]
fn closed_stdin_quarantines_queued_bytes_without_retry() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import os,time; os.close(0); print('closed',flush=True); time.sleep(10)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert_eq!(frame(&child, &scope).unwrap(), b"closed");
    child.enqueue_metadata(&scope, &metadata()).unwrap();
    assert_eq!(child.flush_stdin(&scope), Err(Error::PipeClosed));
    assert_eq!(
        child.enqueue_metadata(&scope, &metadata()),
        Err(Error::PipeClosed)
    );
    assert_eq!(child.flush_stdin(&scope), Err(Error::PipeClosed));
}

#[test]
fn input_to_nonreading_child_remains_bounded_and_nonblocking() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let bounds = TransportBounds {
        max_frame_bytes: 65536,
        max_pending_frames: 2,
        io_bytes_per_poll: 1024,
    };
    let child = fixture
        .executor(&authority, &scope, "import time; time.sleep(10)", bounds)
        .spawn(&scope)
        .unwrap();
    let value = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"x".repeat(60000)},"capabilities":{"experimentalApi":false}}});
    let bytes = serde_json::to_vec(&value).unwrap();
    child.enqueue_metadata(&scope, &bytes).unwrap();
    child.enqueue_metadata(&scope, &bytes).unwrap();
    assert_eq!(
        child.enqueue_metadata(&scope, &bytes),
        Err(Error::Backpressure)
    );
    // Once the kernel pipe fills, calls return with zero progress, without waiting
    // for the sleeping child. A fixed iteration count bounds the test work.
    let mut blocked = false;
    for _ in 0..100 {
        let flush = child.flush_stdin(&scope).unwrap();
        assert!(flush.written <= 1024);
        if flush.written == 0 {
            blocked = true;
            break;
        }
    }
    assert!(blocked);
    authority.revoke().unwrap();
}
