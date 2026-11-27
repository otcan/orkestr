use super::*;

fn limits() -> Arc<AuthLimits> {
    Arc::new(AuthLimits::default())
}

fn address(value: &str) -> Peer {
    Peer(Some(value.parse().unwrap()))
}

fn sign_in(name: &str, peer: Peer) -> [Key; 3] {
    [Key::username(name), Key::source(peer), Key::Server]
}

#[test]
fn a_key_renewal_of_many_credentials_is_not_limited() {
    // A nightly renewal, per key: two owner sign-ins, a password-confirmed
    // credential create and a service exchange, all from one loopback source.
    let limits = limits();
    let now = Instant::now();
    let local = address("127.0.0.1");
    for index in 0..16 {
        for _ in 0..3 {
            limits
                .begin_at(now, &sign_in("owner", local))
                .unwrap()
                .cleared();
        }
        limits
            .begin_at(now, &[Key::ServiceCredential(format!("key-{index}"))])
            .unwrap()
            .cleared();
    }
    // Another credential's consumer is unaffected by the renewal.
    assert!(limits
        .begin_at(now, &[Key::ServiceCredential("adapter".into())])
        .is_some());
}

#[test]
fn failures_lock_only_the_presented_client() {
    let limits = limits();
    let now = Instant::now();
    let attacker = address("192.0.2.7");
    for _ in 0..CLIENT.failures {
        drop(limits.begin_at(now, &sign_in("owner", attacker)).unwrap());
    }
    // The username is locked for everyone, the right password included.
    assert!(limits
        .begin_at(now, &sign_in("owner", address("198.51.100.1")))
        .is_none());
    // Other usernames and service credentials still sign in.
    assert!(limits
        .begin_at(now, &sign_in("other", address("198.51.100.1")))
        .is_some());
    assert!(limits
        .begin_at(now, &[Key::ServiceCredential("adapter".into())])
        .is_some());
    // The lockout ends with the failure window, not with the attempt window.
    assert!(limits
        .begin_at(now + MINUTE, &sign_in("owner", address("198.51.100.1")))
        .is_none());
    assert!(limits
        .begin_at(
            now + CLIENT.failure_window,
            &sign_in("owner", address("198.51.100.1"))
        )
        .is_some());
}

#[test]
fn failures_are_counted_more_strictly_than_successes() {
    let limits = limits();
    let now = Instant::now();
    let local = address("127.0.0.1");
    for _ in 0..CLIENT.attempts {
        limits
            .begin_at(now, &sign_in("owner", local))
            .unwrap()
            .cleared();
    }
    // Successes spend the attempt budget only, which a minute restores.
    assert!(limits.begin_at(now, &sign_in("owner", local)).is_none());
    let later = now + MINUTE;
    for _ in 0..CLIENT.failures {
        drop(limits.begin_at(later, &sign_in("owner", local)).unwrap());
    }
    assert!(limits
        .begin_at(later + MINUTE, &sign_in("owner", local))
        .is_none());
}

#[test]
fn parallel_guesses_are_held_as_failures_until_they_clear() {
    let limits = limits();
    let now = Instant::now();
    let peer = address("192.0.2.7");
    let in_flight: Vec<_> = (0..CLIENT.failures)
        .map(|_| limits.begin_at(now, &sign_in("owner", peer)).unwrap())
        .collect();
    assert!(limits.begin_at(now, &sign_in("owner", peer)).is_none());
    for attempt in in_flight {
        attempt.cleared();
    }
    assert!(limits.begin_at(now, &sign_in("owner", peer)).is_some());
}

#[test]
fn refused_attempts_do_not_extend_a_lockout() {
    let limits = limits();
    let now = Instant::now();
    let peer = address("192.0.2.7");
    for _ in 0..CLIENT.failures {
        drop(limits.begin_at(now, &sign_in("owner", peer)).unwrap());
    }
    for second in 0..900 {
        let at = now + Duration::from_secs(second);
        assert!(limits.begin_at(at, &sign_in("owner", peer)).is_none());
    }
    assert!(limits
        .begin_at(now + CLIENT.failure_window, &sign_in("owner", peer))
        .is_some());
}

#[test]
fn unknown_tokens_from_one_source_do_not_lock_out_known_credentials() {
    let limits = limits();
    let now = Instant::now();
    let local = address("127.0.0.1");
    let unknown = [Key::source(local), Key::Server];
    for _ in 0..SOURCE.failures {
        drop(limits.begin_at(now, &unknown).unwrap());
    }
    assert!(limits.begin_at(now, &unknown).is_none());
    // A revoked credential that keeps retrying only locks itself.
    for _ in 0..CLIENT.failures {
        drop(
            limits
                .begin_at(now, &[Key::ServiceCredential("revoked".into())])
                .unwrap(),
        );
    }
    assert!(limits
        .begin_at(now, &[Key::ServiceCredential("revoked".into())])
        .is_none());
    assert!(limits
        .begin_at(now, &[Key::ServiceCredential("active".into())])
        .is_some());
}

#[test]
fn spraying_usernames_is_bounded_per_source_and_per_server() {
    let limits = limits();
    let now = Instant::now();
    let sprayer = address("192.0.2.7");
    for index in 0..SOURCE.failures {
        drop(
            limits
                .begin_at(now, &sign_in(&format!("guess-{index}"), sprayer))
                .unwrap(),
        );
    }
    assert!(limits
        .begin_at(now, &sign_in("guess-new", sprayer))
        .is_none());
    assert!(limits
        .begin_at(now, &sign_in("owner", address("198.51.100.1")))
        .is_some());
    // Spread sources meet the server-wide failure ceiling.
    let limits = self::limits();
    for index in 0..SERVER.failures {
        let peer = address(&format!("10.0.{}.{}", index / 256, index % 256));
        drop(
            limits
                .begin_at(now, &sign_in(&format!("guess-{index}"), peer))
                .unwrap(),
        );
    }
    assert!(limits
        .begin_at(now, &sign_in("owner", address("198.51.100.1")))
        .is_none());
    assert!(limits
        .begin_at(
            now + SERVER.failure_window,
            &sign_in("owner", address("198.51.100.1"))
        )
        .is_some());
}

#[test]
fn a_refused_attempt_charges_no_key() {
    let limits = limits();
    let now = Instant::now();
    let peer = address("192.0.2.7");
    for _ in 0..CLIENT.failures {
        drop(limits.begin_at(now, &sign_in("owner", peer)).unwrap());
    }
    // "owner" is full; the refusal must not spend the source or server budget.
    for _ in 0..1000 {
        assert!(limits.begin_at(now, &sign_in("owner", peer)).is_none());
    }
    let buckets = limits.buckets.lock().unwrap();
    assert_eq!(buckets[&Key::source(peer)].failures.used, CLIENT.failures);
    assert_eq!(buckets[&Key::Server].failures.used, CLIENT.failures);
}

#[test]
fn a_cleared_attempt_does_not_refund_a_later_window() {
    let limits = limits();
    let now = Instant::now();
    let key = [Key::ServiceCredential("slow".into())];
    let slow = limits.begin_at(now, &key).unwrap();
    let later = now + CLIENT.failure_window;
    drop(limits.begin_at(later, &key).unwrap());
    slow.cleared();
    let buckets = limits.buckets.lock().unwrap();
    assert_eq!(buckets[&key[0]].failures.used, 1);
}

#[test]
fn idle_buckets_are_dropped_and_the_map_is_bounded() {
    let limits = limits();
    let now = Instant::now();
    for index in 0..PRUNE_AT {
        limits
            .begin_at(now, &[Key::ServiceCredential(format!("key-{index}"))])
            .unwrap()
            .cleared();
    }
    limits
        .begin_at(
            now + QUARTER_HOUR,
            &[Key::ServiceCredential("fresh".into())],
        )
        .unwrap()
        .cleared();
    assert_eq!(limits.buckets.lock().unwrap().len(), 1);
    let limits = self::limits();
    {
        let mut buckets = limits.buckets.lock().unwrap();
        for index in 0..CAPACITY {
            buckets.insert(
                Key::ServiceCredential(format!("key-{index}")),
                Bucket::new(now),
            );
        }
    }
    assert!(limits
        .begin_at(now, &[Key::ServiceCredential("new".into())])
        .is_none());
    assert!(limits
        .begin_at(now, &[Key::ServiceCredential("key-1".into())])
        .is_some());
}

#[test]
fn usernames_are_kept_hashed_and_distinct() {
    assert_eq!(Key::username("owner"), Key::username("owner"));
    assert_ne!(Key::username("owner"), Key::username("Owner"));
    assert!(matches!(Key::username("owner"), Key::Username(_)));
}

#[test]
fn the_source_is_the_proxy_entry_only_behind_a_local_proxy() {
    let forwarded = |values: &[&str]| {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append("x-forwarded-for", value.parse().unwrap());
        }
        headers
    };
    let loopback = Some("127.0.0.1".parse().unwrap());
    // The proxy appends the client it saw; earlier entries are client-supplied.
    assert_eq!(
        Peer::of(loopback, &forwarded(&["203.0.113.9, 192.0.2.7"])),
        address("192.0.2.7")
    );
    assert_eq!(
        Peer::of(loopback, &forwarded(&["203.0.113.9", "192.0.2.7"])),
        address("192.0.2.7")
    );
    assert_eq!(
        Peer::of(Some("::1".parse().unwrap()), &forwarded(&["2001:db8::1"])),
        address("2001:db8::1")
    );
    // No or unreadable header: the loopback peer itself.
    assert_eq!(Peer::of(loopback, &HeaderMap::new()), address("127.0.0.1"));
    assert_eq!(
        Peer::of(loopback, &forwarded(&["not-an-address"])),
        address("127.0.0.1")
    );
    // A peer that is not loopback cannot choose its source.
    assert_eq!(
        Peer::of(
            Some("172.17.0.1".parse().unwrap()),
            &forwarded(&["192.0.2.7"])
        ),
        address("172.17.0.1")
    );
    // IPv4-mapped loopback is loopback.
    assert_eq!(
        Peer::of(
            Some("::ffff:127.0.0.1".parse().unwrap()),
            &forwarded(&["192.0.2.7"])
        ),
        address("192.0.2.7")
    );
    assert_eq!(Peer::of(None, &forwarded(&["192.0.2.7"])), Peer(None));
}
