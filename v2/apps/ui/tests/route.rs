use orkestr_v2_contracts::HostMetricsRange;
use orkestr_v2_ui::route::{Route, Tab};

const ID: &str = "969f5efc-a8f6-4112-a84c-6224d4c38174";

#[test]
fn every_view_round_trips_through_its_fragment() {
    let routes = [
        Route::Conversation {
            id: ID.into(),
            tab: Tab::Chat,
        },
        Route::Conversation {
            id: ID.into(),
            tab: Tab::Timers,
        },
        Route::Conversation {
            id: ID.into(),
            tab: Tab::LiveMap,
        },
        Route::V1Thread {
            thread: "group-coordinated".into(),
        },
        Route::Host {
            charts: false,
            range: HostMetricsRange::Hour1,
        },
        Route::Host {
            charts: true,
            range: HostMetricsRange::Hours24,
        },
    ];
    for route in routes {
        assert_eq!(
            Route::parse(&route.hash()),
            Some(route.clone()),
            "{}",
            route.hash()
        );
    }
    assert_eq!(
        Route::Conversation {
            id: ID.into(),
            tab: Tab::Timers
        }
        .hash(),
        format!("#conversation/{ID}/timers")
    );
    assert_eq!(
        Route::Host {
            charts: true,
            range: HostMetricsRange::Days7
        }
        .hash(),
        "#host/details?range=7d"
    );
    assert_eq!(
        Route::parse("#host"),
        Some(Route::Host {
            charts: false,
            range: HostMetricsRange::Hour1
        })
    );
    assert_eq!(
        Route::parse(&format!("#conversation/{}", ID.to_uppercase())),
        Some(Route::Conversation {
            id: ID.into(),
            tab: Tab::Chat
        })
    );
}

#[test]
fn unknown_or_hostile_fragments_are_ignored() {
    for hash in [
        "",
        "#",
        "#conversation/not-a-uuid",
        "#conversation/00000000-0000-0000-0000-000000000000",
        &format!("#conversation/{ID}/host"),
        &format!("#conversation/{ID}/nope"),
        "#v1/../x",
        "#v1/a b",
        "#host/details?range=2h",
        "#host/other",
        "#v1-link/ins_x/thr_y",
    ] {
        assert_eq!(Route::parse(hash), None, "{hash}");
    }
    assert_eq!(Tab::from_label("Host resources"), Some(Tab::Host));
}
