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
        Route::Conversation {
            id: ID.into(),
            tab: Tab::Files,
        },
        Route::VirtualDesks,
        Route::OrkestrSettings,
        Route::Credentials,
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
        &format!("#conversation/{ID}/orkestr-settings"),
        &format!("#conversation/{ID}/nope"),
        "#settings/other",
        "/settings",
        "#v1/../x",
        "#v1/a b",
        "#host/details?range=2h",
        "#host/other",
        "#v1-link/ins_x/thr_y",
    ] {
        assert_eq!(Route::parse(hash), None, "{hash}");
    }
    assert_eq!(Tab::from_label("Host resources"), Some(Tab::Host));
    assert_eq!(Tab::from_label("Virtual desks"), Some(Tab::VirtualDesks));
}

#[test]
fn desks_are_global_and_old_links_remain_compatible() {
    for location in [
        "/virtual-desks",
        "/virtual-desks/",
        "#virtual-desks",
        &format!("#conversation/{ID}/virtual-desks"),
    ] {
        assert_eq!(Route::parse(location), Some(Route::VirtualDesks));
    }
    assert_eq!(Route::VirtualDesks.hash(), "/virtual-desks");
    assert_eq!(Route::parse("#conversation/not-a-uuid/virtual-desks"), None);
    assert_eq!(Route::parse("/virtual-desks/other"), None);
}

#[test]
fn every_destination_has_exactly_one_place_in_the_navigation() {
    // Chat, Work and Files first; the conversation's other views under More;
    // owner-wide views in the app header. Nothing is lost or listed twice.
    assert_eq!(Tab::PRIMARY, [Tab::Chat, Tab::Work, Tab::Files]);
    let mut placed: Vec<Tab> = Tab::PRIMARY
        .into_iter()
        .chain(Tab::MORE)
        .chain(Tab::GLOBAL)
        .collect();
    assert_eq!(placed.len(), Tab::ALL.len());
    for tab in Tab::ALL {
        assert_eq!(
            placed.iter().filter(|t| **t == tab).count(),
            1,
            "{}",
            tab.label()
        );
    }
    placed.dedup();
    assert_eq!(placed.len(), Tab::ALL.len());
    let more: Vec<&str> = Tab::MORE.iter().map(|t| t.label()).collect();
    assert_eq!(
        more,
        [
            "History",
            "Projects",
            "Timers",
            "Job tracker",
            "Memory",
            "Live map",
            "Chat settings"
        ]
    );
    assert!(Tab::Timers.in_more() && !Tab::Files.in_more() && !Tab::Host.in_more());
}

#[test]
fn conversation_destinations_stay_bookmarkable_and_global_ones_carry_no_conversation() {
    for tab in Tab::PRIMARY.into_iter().chain(Tab::MORE) {
        assert!(!tab.is_global(), "{}", tab.label());
        let route = Route::Conversation { id: ID.into(), tab };
        assert_eq!(
            Route::parse(&route.hash()),
            Some(route.clone()),
            "{}",
            route.hash()
        );
        assert!(route.hash().starts_with(&format!("#conversation/{ID}")));
    }
    assert_eq!(
        Route::parse(&format!("#conversation/{ID}/files")),
        Some(Route::Conversation {
            id: ID.into(),
            tab: Tab::Files
        })
    );
    assert_eq!(Tab::from_label("Files"), Some(Tab::Files));
    // Owner-wide views: their own locations, never a conversation's.
    assert!(Tab::VirtualDesks.is_global() && Tab::Host.is_global());
    assert!(!Route::VirtualDesks.hash().contains(ID));
    let host = Route::Host {
        charts: false,
        range: HostMetricsRange::Hour1,
    };
    assert_eq!(host.hash(), "#host");
    assert_eq!(Route::parse(&format!("#conversation/{ID}/host")), None);
    assert_eq!(
        Route::parse(&format!("#conversation/{ID}/virtual-desks")),
        Some(Route::VirtualDesks),
        "an old conversation-scoped desks link opens the global view"
    );
}

#[test]
fn the_reload_pointer_accepts_every_conversation_destination() {
    // `selected_conversation.mjs` decides which fragments survive a reload;
    // a tab missing from its pattern would fall back to Chat (ORK-786).
    let pattern = include_str!("../src/selected_conversation.mjs")
        .lines()
        .next()
        .expect("pattern line")
        .to_owned();
    // Conversation destinations, plus old `#conversation/<id>/virtual-desks` links.
    for tab in Tab::ALL
        .into_iter()
        .filter(|t| !t.is_global() || *t == Tab::VirtualDesks)
    {
        assert!(
            pattern.contains(&format!("|{}|", tab.slug()))
                || pattern.contains(&format!("(?:{}|", tab.slug()))
                || pattern.contains(&format!("|{}))", tab.slug())),
            "{} missing from the reload pattern",
            tab.slug()
        );
    }
}

#[test]
fn orkestr_settings_are_global_and_chat_settings_stay_with_the_chat() {
    // ORK-789: account, vault, provider sign-in and About live at `#settings`,
    // an owner-wide view opened from the header; a chat's settings stay under
    // its More menu at the URL old bookmarks use.
    assert_eq!(Route::parse("#settings"), Some(Route::OrkestrSettings));
    assert_eq!(Route::OrkestrSettings.hash(), "#settings");
    assert!(Tab::GLOBAL.contains(&Tab::OrkestrSettings));
    assert!(Tab::OrkestrSettings.is_global() && !Tab::OrkestrSettings.in_more());
    assert!(Tab::Settings.in_more() && !Tab::Settings.is_global());
    assert_eq!(Tab::Settings.label(), "Chat settings");
    assert_eq!(Tab::OrkestrSettings.label(), "Orkestr settings");
    assert_eq!(
        Route::parse(&format!("#conversation/{ID}/settings")),
        Some(Route::Conversation {
            id: ID.into(),
            tab: Tab::Settings
        }),
        "an old chat settings bookmark still opens that chat's settings"
    );
    assert_eq!(
        Route::Conversation {
            id: ID.into(),
            tab: Tab::Settings
        }
        .hash(),
        format!("#conversation/{ID}/settings")
    );
    assert_eq!(
        Route::parse(&format!("#conversation/{ID}/orkestr-settings")),
        None,
        "Orkestr settings never take a conversation's scope"
    );
}

#[test]
fn credentials_are_a_global_page_reached_from_orkestr_settings() {
    // ORK-826: the owner's passwords, tokens and API keys at `#credentials`,
    // never inside a conversation's scope.
    assert_eq!(Route::parse("#credentials"), Some(Route::Credentials));
    assert_eq!(Route::Credentials.hash(), "#credentials");
    assert!(Tab::Credentials.is_global() && !Tab::Credentials.in_more());
    assert_eq!(Tab::Credentials.label(), "Credentials");
    assert_eq!(
        Route::parse(&format!("#conversation/{ID}/credentials")),
        None,
        "credentials never take a conversation's scope"
    );
}
