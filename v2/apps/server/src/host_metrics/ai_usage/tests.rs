//! Synthetic fixtures only: made-up ids, models, paths and numbers.
use super::{
    config::{self, Pricing, Source},
    ledger::{Ledger, Session},
    owners::{Directory, Thread},
    parse::{claude_line, CodexState},
    procs::classify,
    scan::Scanner,
    *,
};
use orkestr_v2_contracts::{AiOwnerKind, AiProvider, AiTokens};
use std::{collections::HashMap, io::Write};

const T0: &str = "2030-01-02T10:00:00.000Z";
const T0_MS: i64 = 1_893_578_400_000;

fn ts(minutes: i64) -> String {
    let t = T0_MS + minutes * 60_000;
    let secs = t / 1000;
    let (h, m) = (secs % 86_400 / 3600, secs % 3600 / 60);
    format!("{}T{h:02}:{m:02}:00.000Z", date_label(t))
}

fn claude(session: &str, msg: &str, minute: i64, model: &str, (i, o, r, w): (u64, u64, u64, u64)) -> String {
    format!(
        r#"{{"parentUuid":null,"isSidechain":false,"message":{{"id":"{msg}","model":"{model}","role":"assistant","content":[{{"type":"text","text":"SECRET PROMPT TEXT"}}],"usage":{{"input_tokens":{i},"output_tokens":{o},"cache_read_input_tokens":{r},"cache_creation_input_tokens":{w}}}}},"requestId":"req-{msg}","type":"assistant","timestamp":"{}","sessionId":"{session}","cwd":"/srv/example/private-dir"}}"#,
        ts(minute)
    )
}

fn codex_meta(id: &str, cwd: &str) -> String {
    format!(r#"{{"timestamp":"{T0}","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","base_instructions":"SECRET"}}}}"#)
}

fn codex_turn(model: &str) -> String {
    format!(r#"{{"timestamp":"{T0}","ordinal":2,"type":"turn_context","payload":{{"model":"{model}","user_instructions":"SECRET"}}}}"#)
}

fn codex_tokens(minute: i64, ordinal: u64, total: (u64, u64, u64), last: (u64, u64, u64), used: f32) -> String {
    format!(
        r#"{{"timestamp":"{}","ordinal":{ordinal},"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{},"cached_input_tokens":{},"output_tokens":{}}},"last_token_usage":{{"input_tokens":{},"cached_input_tokens":{},"output_tokens":{}}}}},"rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":{}}},"secondary":{{"used_percent":5.0,"window_minutes":10080,"resets_at":{}}}}}}}}}"#,
        ts(minute), total.0, total.1, total.2, last.0, last.1, last.2,
        (T0_MS / 1000) + 3 * 3600,
        (T0_MS / 1000) + 3 * 86_400
    )
}

#[test]
fn claude_lines_give_usage_and_skip_content() {
    let line = claude("s-1", "m-1", 0, "claude-opus-5-5", (10, 20, 300, 40));
    let parsed = claude_line(line.as_bytes()).unwrap();
    let usage = parsed.usage.unwrap();
    assert_eq!(usage.t_ms, T0_MS);
    assert_eq!(usage.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(usage.tokens, AiTokens { input: 10, output: 20, cache_read: 300, cache_write: 40, requests: 1 });
    assert!(usage.dedupe.is_some());
    assert_eq!(parsed.session_id.as_deref(), Some("s-1"));
    // Lines without usage or limits are not parsed at all.
    assert!(claude_line(br#"{"type":"user","message":{"content":"hello"}}"#).is_none());
    // A refused request carries the 5-hour limit and its reset.
    let quota = format!(r#"{{"type":"assistant","timestamp":"{T0}","sessionId":"s-1","quotaLimits":{{"status":"rejected","resetsAt":{},"rateLimitType":"five_hour"}},"error":"rate_limit"}}"#, T0_MS / 1000 + 3600);
    let limit = claude_line(quota.as_bytes()).unwrap().limit.unwrap();
    assert_eq!((limit.limit_id.as_str(), limit.window_minutes, limit.reached), ("five_hour", 300, true));
    assert_eq!(limit.resets_at_ms, Some(T0_MS + 3_600_000));
}

#[test]
fn codex_counts_each_response_once_and_skips_copied_history() {
    let mut state = CodexState::default();
    let meta = state.line(codex_meta("c-1", "/srv/example/ws").as_bytes()).unwrap().meta.unwrap();
    assert_eq!(meta.id, "c-1");
    state.line(codex_turn("example-codex-model").as_bytes());
    let first = state.line(codex_tokens(0, 3, (100, 60, 5), (100, 60, 5), 10.0).as_bytes()).unwrap();
    let usage = first.usage.unwrap();
    // Cached input is counted as cache reads, not new input.
    assert_eq!(usage.tokens, AiTokens { input: 40, output: 5, cache_read: 60, cache_write: 0, requests: 1 });
    assert_eq!(usage.model.as_deref(), Some("example-codex-model"));
    assert_eq!(first.limits.len(), 2);
    assert_eq!(first.limits[0].window_minutes, 300);
    // The same totals repeated are not a new response.
    let repeat = state.line(codex_tokens(1, 4, (100, 60, 5), (100, 60, 5), 10.0).as_bytes()).unwrap();
    assert!(repeat.usage.is_none());
    // A fork's copied history (before its start ordinal) is not counted.
    let mut fork = CodexState::default();
    let forked = format!(r#"{{"timestamp":"{T0}","type":"session_meta","payload":{{"id":"c-2","forked_from_id":"c-1","subagent_history_start_ordinal":10}}}}"#);
    assert_eq!(fork.line(forked.as_bytes()).unwrap().meta.unwrap().parent.as_deref(), Some("c-1"));
    assert!(fork.line(codex_tokens(0, 5, (100, 60, 5), (100, 60, 5), 10.0).as_bytes()).unwrap().usage.is_none());
    assert!(fork.line(codex_tokens(1, 11, (150, 60, 9), (50, 0, 4), 10.0).as_bytes()).unwrap().usage.is_some());
    // Other event lines are skipped without parsing.
    assert!(state.line(br#"{"timestamp":"x","type":"response_item","payload":{"type":"message"}}"#).is_none());
}

struct Dir(std::path::PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn temp(name: &str) -> Dir {
    let dir = std::env::temp_dir().join(format!("ai-usage-{name}-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    Dir(dir)
}

fn source(provider: AiProvider, path: &std::path::Path) -> Source {
    Source { provider, label: "Example".into(), path: path.to_owned(), account: None, coordinator: true }
}

#[test]
fn scanner_reads_incrementally_dedupes_and_waits_for_complete_lines() {
    let dir = temp("scan");
    let claude_dir = dir.0.join("claude/project");
    std::fs::create_dir_all(&claude_dir).unwrap();
    let file = claude_dir.join("s-1.jsonl");
    let a = claude("s-1", "m-1", 0, "claude-opus-5-5", (1, 2, 3, 4));
    std::fs::write(&file, format!("{a}\n{a}\n")).unwrap();
    let sources = vec![source(AiProvider::Claude, &dir.0.join("claude"))];
    let mut ledger = Ledger::default();
    let mut scanner = Scanner::new(HashMap::new());
    let now = T0_MS + 600_000;
    scanner.pass(&sources, &mut ledger, now, 1 << 20);
    let total = |l: &Ledger| l.buckets.values().fold(AiTokens::default(), |mut t, b| { t.add(b); t });
    // The repeated response line is counted once.
    assert_eq!(total(&ledger).total(), 10);
    // A partial line is left for the next pass, then read once complete.
    let b = claude("s-1", "m-2", 1, "claude-opus-5-5", (10, 0, 0, 0));
    let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
    f.write_all(&b.as_bytes()[..40]).unwrap();
    scanner.pass(&sources, &mut ledger, now, 1 << 20);
    assert_eq!(total(&ledger).total(), 10);
    f.write_all(&b.as_bytes()[40..]).unwrap();
    f.write_all(b"\n").unwrap();
    scanner.pass(&sources, &mut ledger, now, 1 << 20);
    assert_eq!(total(&ledger).total(), 20);
    assert!(!scanner.exhausted);
    // A moved file keeps its cursor (same inode): nothing is counted twice.
    std::fs::rename(&file, claude_dir.join("moved.jsonl")).unwrap();
    scanner.pass(&sources, &mut ledger, now, 1 << 20);
    assert_eq!(total(&ledger).total(), 20);
    // Persisted form round-trips.
    let restored = Ledger::restore(ledger.save()).unwrap();
    assert_eq!(restored.buckets, ledger.buckets);
    assert_eq!(restored.sessions, ledger.sessions);
}

#[test]
fn scanner_budget_spreads_the_backfill_over_passes() {
    let dir = temp("budget");
    let path = dir.0.join("rollout-c-1.jsonl");
    let mut text = codex_meta("c-1", "/srv/example/ws") + "\n" + &codex_turn("example-codex-model") + "\n";
    for i in 0..50u64 {
        text += &codex_tokens(i as i64, 10 + i, (100 * (i + 1), 0, i + 1), (100, 0, 1), 10.0);
        text += "\n";
    }
    std::fs::write(&path, text).unwrap();
    let sources = vec![source(AiProvider::Codex, &dir.0)];
    let mut ledger = Ledger::default();
    let mut scanner = Scanner::new(HashMap::new());
    let now = T0_MS + 3_600_000;
    scanner.pass(&sources, &mut ledger, now, 2048);
    assert!(scanner.exhausted);
    let mut passes = 1;
    while scanner.exhausted && passes < 100 {
        scanner.pass(&sources, &mut ledger, now, 2048);
        passes += 1;
    }
    assert!(passes > 2);
    let requests: u64 = ledger.buckets.values().map(|t| t.requests).sum();
    assert_eq!(requests, 50);
    assert!(ledger.limits.values().any(|l| l.latest.window_minutes == 300));
}

fn session(provider: AiProvider, id: &str, cwd: Option<&str>) -> Session {
    Session { provider, id: id.into(), source: 0, cwd: cwd.map(str::to_owned), parent: None, agent: None, first_ms: T0_MS, last_ms: T0_MS, model: None }
}

#[test]
fn owners_follow_runs_threads_live_map_and_directories() {
    let mut dir = Directory {
        coordinator_sources: vec![true],
        ..Default::default()
    };
    dir.runs.insert("native-1".into(), ("conv-1".into(), "deep".into()));
    dir.names.insert("conv-1".into(), "Example conversation".into());
    dir.threads.push(Thread { id: "thr-a".into(), name: "Thread A".into(), codex_thread_id: Some("codex-a".into()), workspace: Some("/srv/example/thread-a".into()), conversation: None });
    dir.threads.push(Thread { id: "thr-b".into(), name: "Thread B".into(), codex_thread_id: None, workspace: None, conversation: Some("conv-1".into()) });
    dir.attached.insert("claude-coord".into(), "thr-a".into());
    let none = |_: AiProvider, _: &str| None;
    let v2 = dir.resolve(&session(AiProvider::Codex, "native-1", None), &none);
    assert_eq!((v2.kind, v2.label.as_str(), v2.link.as_deref(), v2.role.as_deref()), (AiOwnerKind::Conversation, "Example conversation", Some("#conversation/conv-1"), Some("deep")));
    let thread = dir.resolve(&session(AiProvider::Codex, "codex-a", None), &none);
    assert_eq!((thread.kind, thread.link.as_deref()), (AiOwnerKind::Thread, Some("#v1/thr-a")));
    let by_dir = dir.resolve(&session(AiProvider::Claude, "x", Some("/srv/example/thread-a/sub")), &none);
    assert_eq!(by_dir.key, "thread:thr-a");
    let coordinator = dir.resolve(&session(AiProvider::Claude, "claude-coord", None), &none);
    assert_eq!(coordinator.kind, AiOwnerKind::Coordinator);
    assert_eq!(coordinator.label, "Coordinator of Thread A");
    let parent = session(AiProvider::Claude, "claude-coord", None);
    let mut agent = session(AiProvider::Claude, "agent:a1", None);
    agent.parent = Some("claude-coord".into());
    agent.agent = Some("general-purpose".into());
    let find = move |_: AiProvider, id: &str| (id == "claude-coord").then(|| parent.clone());
    let helpers = dir.resolve(&agent, &find);
    assert_eq!(helpers.kind, AiOwnerKind::Agent);
    assert_eq!(helpers.key, "agents:coordinator:thr-a");
    let unknown = dir.resolve(&session(AiProvider::Claude, "abcdef123456", Some("/elsewhere")), &none);
    assert_eq!((unknown.kind, unknown.label.as_str()), (AiOwnerKind::Coordinator, "Claude Code session abcdef12"));
}

#[test]
fn pricing_matches_models_and_prefixes() {
    let pricing = Pricing::with(HashMap::new());
    let million = AiTokens { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000, requests: 1 };
    assert_eq!(pricing.cost("claude-opus-5-5", &million), Some(4.0 + 20.0 + 0.2 + 5.0));
    assert!(pricing.cost("claude-opus-4-8", &million).is_some());
    assert!(pricing.cost("example-codex-model", &million).is_none());
    let cfg = config::parse(br#"{"sources":[],"pricing":{"example-codex-model":{"input":1.0,"output":2.0}}}"#).unwrap();
    assert_eq!(cfg.pricing.cost("example-codex-model", &million), Some(1.0 + 2.0 + 0.1 + 1.25));
    assert!(config::parse(br#"{"sources":[{"provider":"codex","label":"x","path":"relative"}]}"#).is_none());
    let defaults = config::defaults(&|k| (k == "HOME").then(|| "/home/example".to_owned()));
    assert_eq!(defaults.len(), 3);
}

#[test]
fn programs_are_recognized_from_their_command() {
    assert_eq!(classify("claude", &["claude", "--x"]).map(|c| c.0), Some(AiProvider::Claude));
    assert_eq!(classify("node", &["node", "/usr/bin/codex", "app-server"]), Some((AiProvider::Codex, "Codex app server")));
    assert_eq!(classify("codex", &["/opt/x/bin/codex", "exec"]), Some((AiProvider::Codex, "Codex")));
    assert_eq!(classify("python3", &["python3", "/home/x/.codex-ops/app.py"]), None);
    assert_eq!(classify("node", &["node", "server.js"]), None);
}

fn snapshot_with_usage() -> Snapshot {
    let dir_sources = vec![
        source(AiProvider::Claude, std::path::Path::new("/srv/example/claude")),
        source(AiProvider::Codex, std::path::Path::new("/srv/example/codex")),
    ];
    let mut ledger = Ledger::default();
    let now = T0_MS + 59 * 60_000 + 30_000;
    let c = ledger.session(AiProvider::Claude, "s-1", 0, T0_MS);
    ledger.sessions[c as usize].cwd = Some("/srv/example/private-dir".into());
    for m in 0..60 {
        let line = claude("s-1", &format!("m-{m}"), m, "claude-opus-5-5", (100, 50, 1000, 10));
        ledger.record(c, &claude_line(line.as_bytes()).unwrap().usage.unwrap(), now);
    }
    let x = ledger.session(AiProvider::Codex, "native-1", 1, T0_MS);
    let mut state = CodexState::default();
    state.line(codex_turn("example-codex-model").as_bytes());
    for m in 0..60u64 {
        let parsed = state
            .line(codex_tokens(m as i64, m + 3, (100 * (m + 1), 0, m + 1), (100, 0, 1), 10.0 + m as f32).as_bytes())
            .unwrap();
        ledger.record(x, &parsed.usage.unwrap(), now);
        for l in &parsed.limits {
            ledger.limit(AiProvider::Codex, "Example", l);
        }
    }
    Snapshot {
        ledger,
        programs: Vec::new(),
        config: config::Config { sources: dir_sources, pricing: Pricing::with(HashMap::new()) },
        stats: Vec::new(),
        observed_at_ms: now,
        collecting: false,
        backfill_percent: None,
    }
}

#[test]
fn report_has_windows_top_consumers_pace_and_no_paths_or_text() {
    let snapshot = snapshot_with_usage();
    let mut dir = Directory::default();
    dir.runs.insert("native-1".into(), ("conv-1".into(), "deep".into()));
    dir.names.insert("conv-1".into(), "Example conversation".into());
    let now = snapshot.observed_at_ms;
    let usage = build(&snapshot, &dir, now);
    assert!(usage.is_valid());
    let hour = &usage.windows[0];
    assert_eq!(hour.range, "1h");
    assert_eq!(hour.total.requests, 120);
    assert_eq!(hour.series.iter().map(|s| s.points.len()).max(), Some(60));
    assert_eq!(hour.unpriced_models, vec!["example-codex-model".to_owned()]);
    // 60 Claude responses at Opus 5.5 list prices.
    let expected = 60.0 * (100.0 * 4.0 + 50.0 * 20.0 + 1000.0 * 0.2 + 10.0 * 5.0) / 1e6;
    assert!((hour.cost_usd - expected).abs() < 1e-9);
    let conv = hour.top.iter().find(|c| c.kind == AiOwnerKind::Conversation).unwrap();
    assert_eq!((conv.label.as_str(), conv.link.as_deref(), conv.active_minutes), ("Example conversation", Some("#conversation/conv-1"), 60));
    // Codex rose 59 points in an hour: the 5-hour limit fills before its reset.
    let codex = usage.providers.iter().find(|p| p.provider == AiProvider::Codex).unwrap();
    let five = codex.limits.iter().find(|l| l.window_minutes == 300).unwrap();
    let eta = five.projected_full_at_ms.unwrap();
    assert!(eta > now && eta < five.resets_at_ms.unwrap());
    let claude_summary = usage.providers.iter().find(|p| p.provider == AiProvider::Claude).unwrap();
    assert!(claude_summary.burn_tokens_per_minute > 0.0);
    assert_eq!(claude_summary.limits[0].window_started_at_ms, Some(T0_MS));
    assert_eq!(usage.cost_basis, "API-equivalent estimate");
    assert_eq!(usage.active.len(), 2);
    let json = serde_json::to_string(&usage).unwrap();
    for secret in ["/srv/example", "SECRET", "private-dir", "req-m"] {
        assert!(!json.contains(secret), "{secret} leaked");
    }
}

#[test]
fn claude_window_is_sized_from_the_last_refusal() {
    let mut snapshot = snapshot_with_usage();
    let now = snapshot.observed_at_ms;
    // Yesterday the limit was hit after the same activity in a window.
    let day = 24 * 60;
    let c = snapshot.ledger.session(AiProvider::Claude, "s-0", 0, T0_MS - day * 60_000);
    for m in 0..120 {
        let line = claude("s-0", &format!("y-{m}"), m - day, "claude-opus-5-5", (100, 50, 1000, 10));
        snapshot.ledger.record(c, &claude_line(line.as_bytes()).unwrap().usage.unwrap(), now);
    }
    let hit = super::parse::LimitRecord { t_ms: T0_MS - day * 60_000 + 120 * 60_000, limit_id: "five_hour".into(), window_minutes: 300, used_percent: None, resets_at_ms: Some(T0_MS - day * 60_000 + 300 * 60_000), reached: true };
    snapshot.ledger.limit(AiProvider::Claude, "Example", &hit);
    let usage = build(&snapshot, &Directory::default(), now);
    let limit = &usage.providers[0].limits[0];
    assert!(limit.estimated && !limit.reached);
    let used = limit.used_percent.unwrap();
    assert!((used - 50.0).abs() < 1.0, "{used}");
    // At the same pace the window fills in another hour, before it ends.
    let eta = limit.projected_full_at_ms.unwrap();
    assert!((eta - (now + 3_600_000)).abs() < 120_000);
}

#[test]
fn dates_are_civil() {
    assert_eq!(date_label(T0_MS), "2030-01-02");
    assert_eq!(date_label(0), "1970-01-01");
}
