use orkestr_v2_contracts::{AiLimit, AiModelUsage, AiProvider, AiSeries, AiTokens, AiUsageWindow};
use orkestr_v2_ui::ai_usage::*;

const NOW: i64 = 1_893_578_400_000; // 2030-01-02 10:00 UTC

fn limit(projected: Option<i64>, reached: bool) -> AiLimit {
    AiLimit {
        provider: AiProvider::Codex,
        account: "Example".into(),
        label: "5-hour limit".into(),
        window_minutes: 300,
        used_percent: Some(40.0),
        resets_at_ms: Some(NOW + 2 * 3_600_000 + 14 * 60_000),
        observed_at_ms: NOW,
        reached,
        projected_full_at_ms: projected,
        estimated: false,
        note: None,
        window_started_at_ms: None,
        window_tokens: None,
        window_cost_usd: None,
    }
}

#[test]
fn numbers_read_plainly() {
    assert_eq!(tokens(950), "950");
    assert_eq!(tokens(12_340), "12.3k");
    assert_eq!(tokens(4_500_000), "4.5M");
    assert_eq!(tokens(312_000_000), "312M");
    assert_eq!(usd(0.4249), "$0.42");
    assert_eq!(usd(315.2), "$315");
    assert_eq!(usd(1234.0), "$1.2k");
    assert_eq!(duration(45 * 60_000), "45 min");
    assert_eq!(duration(200 * 60_000), "3 h 20 min");
    assert_eq!(duration(52 * 3_600_000), "2 days 4 h");
    assert_eq!(countdown(NOW, NOW + 134 * 60_000), "in 2 h 14 min");
    assert_eq!(countdown(NOW, NOW - 1), "now");
}

#[test]
fn pace_sentences_name_the_time() {
    // Berlin in winter: UTC+1 (offset -60 as `Date` reports it).
    let eta = NOW + 100 * 60_000;
    assert_eq!(
        pace(&limit(Some(eta), false), NOW, -60),
        "At this rate, the 5-hour limit is reached at 12:40 (in 1 h 40 min). It resets at 13:14 (in 2 h 14 min)."
    );
    assert_eq!(
        pace(&limit(None, false), NOW, -60),
        "At this rate, it lasts until the reset. It resets at 13:14 (in 2 h 14 min)."
    );
    assert!(pace(&limit(None, true), NOW, -60).starts_with("The 5-hour limit is reached."));
}

fn window() -> AiUsageWindow {
    AiUsageWindow {
        range: "7d".into(),
        from_ms: NOW - 3 * 3_600_000,
        step_ms: 3_600_000,
        total: AiTokens { input: 10, output: 30, cache_read: 50, cache_write: 10, requests: 4 },
        cost_usd: 1.0,
        unpriced_models: vec![],
        by_model: vec![
            AiModelUsage { provider: AiProvider::Codex, model: "b".into(), tokens: AiTokens::default(), cost_usd: None },
            AiModelUsage { provider: AiProvider::Claude, model: "a".into(), tokens: AiTokens::default(), cost_usd: None },
        ],
        series: vec![
            AiSeries { provider: AiProvider::Claude, model: "a".into(), points: vec![1, 5, 2] },
            AiSeries { provider: AiProvider::Codex, model: "b".into(), points: vec![0, 4, 1] },
        ],
        top: vec![],
    }
}

#[test]
fn charts_aggregate_by_point_hour_and_kind() {
    let w = window();
    assert_eq!(stacked_max(&w), 9);
    assert_eq!(model_order(&w)[0], (AiProvider::Claude, "a".into()));
    assert_eq!(series_class(Some(0)), "series-1");
    assert_eq!(series_class(Some(9)), "series-muted");
    // The middle point (08:00 UTC = 09:00 Berlin) has 9 of 13 tokens.
    let (hour, share) = busiest_hour(&w, -60).unwrap();
    assert_eq!(hour, 9);
    assert!((share - 9.0 * 100.0 / 13.0).abs() < 1e-9);
    let shares = kind_shares(&w.total);
    assert_eq!(shares[0].0, "Read from cache");
    assert!((shares.iter().map(|s| s.3).sum::<f64>() - 100.0).abs() < 1e-9);
    assert_eq!(axis_labels(&w, NOW, 0)[2], "now");
}
