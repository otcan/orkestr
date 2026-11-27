//! Owner inventory labels. Runtime health is never evidence of availability.
use orkestr_v2_contracts::{DesktopReservationKind, DesktopResource, DesktopRuntime};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Available,
    Reserved,
    NeedsCheck,
    Unknown,
}
impl Availability {
    pub fn from_lease(state: &str) -> Self {
        match state {
            "unreserved" => Self::Available,
            "reserved" => Self::Reserved,
            "expired" | "stale" => Self::NeedsCheck,
            _ => Self::Unknown,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Available => "Available to reserve",
            Self::Reserved => "Reserved",
            Self::NeedsCheck => "Reservation needs checking",
            Self::Unknown => "Availability not verified",
        }
    }
    pub fn explanation(self) -> &'static str {
        match self {
            Self::Available => "No reservation was recorded at the last refresh. Reserving checks again.",
            Self::Reserved => "A reservation is recorded. Viewing access is checked separately.",
            Self::NeedsCheck => "The recorded reservation is stale or expired. Check & reserve asks the server to verify it.",
            Self::Unknown => "The inventory could not verify a reservation. This does not mean the desk is free. Check & reserve verifies current availability.",
        }
    }
    pub fn reserve_label(self) -> &'static str {
        match self {
            Self::Available => "Reserve for 10 minutes",
            _ => "Check & reserve",
        }
    }
    /// Styling hook, so an unverified desk cannot be mistaken for a free one.
    pub fn token(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Reserved => "reserved",
            Self::NeedsCheck => "needs-check",
            Self::Unknown => "unknown",
        }
    }
}

/// The reservation state the page shows. V1's lease covers one step only: a
/// desk V2 keeps for a chat between its steps, one handed to the owner, or
/// one the owner is viewing reads as reserved even while V1 holds no lease.
pub fn shown_lease_state(desk: &DesktopResource) -> &str {
    if desk.reserved_in_v2() {
        "reserved"
    } else {
        &desk.lease_state
    }
}

/// Who holds the desk: V1's current holder, else the chat V2 keeps it for,
/// else the owner's own viewing link.
pub fn shown_holder(desk: &DesktopResource) -> Option<String> {
    desk.holder
        .clone()
        .or_else(|| desk.reservation.as_ref().and_then(|r| r.chat.clone()))
        .or_else(|| desk.owner_viewer.as_ref().map(|_| "You (viewing)".into()))
}

pub fn reservation_kind_label(kind: DesktopReservationKind) -> &'static str {
    match kind {
        DesktopReservationKind::Task => "Chat task",
        DesktopReservationKind::OwnerHandoff => "Handed to you",
        DesktopReservationKind::OwnerViewer => "Your viewing link",
    }
}

/// Kind, holder and end of each reservation V2 holds on the desk, one line
/// each; `clock` writes a time in the page's local time.
pub fn reservation_lines(desk: &DesktopResource, clock: impl Fn(i64) -> String) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(claim) = &desk.reservation {
        let chat = claim.chat.as_deref().unwrap_or("a chat");
        let holder = match claim.kind {
            DesktopReservationKind::OwnerHandoff => format!("by {chat}"),
            _ => chat.to_owned(),
        };
        lines.push(format!(
            "{} · {holder} · until {}",
            reservation_kind_label(claim.kind),
            clock(claim.until_ms)
        ));
    }
    if let Some(viewer) = &desk.owner_viewer {
        lines.push(format!(
            "{} · you · until {}",
            reservation_kind_label(viewer.kind),
            clock(viewer.until_ms)
        ));
    }
    lines
}

/// Freeing a desk ends what V2 holds there; say what that lets happen.
/// Free desk ends a chat's claim only; your own viewing ends with End viewing.
pub fn free_desk_help(desk: &DesktopResource) -> &'static str {
    match desk.reservation.as_ref().map(|r| r.kind) {
        Some(DesktopReservationKind::OwnerHandoff) => "End the hand-over now: chats may take the desk again. Do this only when you are done with it.",
        _ => "End this chat's reservation now. Other chats may then take the desk; a running step is not stopped.",
    }
}

/// End viewing ends the owner's window and revokes the link.
pub const END_VIEWING_HELP: &str =
    "End your viewing now: the desk link stops working and chats may take the desk again.";

/// Shown when a link was made but Orkestr could not record that the owner is
/// viewing the desk, so chats were not kept off it.
pub const VIEW_NOT_RECORDED: &str = "This link works, but Orkestr could not record that you are viewing this desk, so chats are not kept off it. A chat may act there while you use it; refresh and try again before typing on the desk.";

/// Whether a Link or Open answer says the viewing window was not recorded. An
/// older server, which does not say, never warns.
pub fn viewer_not_recorded(answer: &serde_json::Value) -> bool {
    answer.get("viewer_recorded") == Some(&serde_json::Value::Bool(false))
}

/// Names what Stop will interrupt, for the confirmation shown before it runs.
pub fn stop_warning(
    desk: &str,
    lease_state: &str,
    holder: Option<&str>,
    expires_at: Option<&str>,
    runtime: DesktopRuntime,
) -> String {
    let who = holder.unwrap_or("A chat");
    match Availability::from_lease(lease_state) {
        Availability::Reserved => {
            let until = expires_at
                .map(|expiry| format!(" until {expiry}"))
                .unwrap_or_default();
            format!(
                "{who} has {desk} reserved{until}. Stopping it now interrupts that chat's work. The reservation stays in place, so the chat will find its desk stopped."
            )
        }
        Availability::NeedsCheck => format!(
            "A stale or expired reservation is recorded for {desk} ({who}). That chat may still be using it. Stopping it interrupts anything running there."
        ),
        Availability::Unknown => format!(
            "The reservation for {desk} could not be verified, so a chat may be using it. Stopping it interrupts anything running there."
        ),
        Availability::Available if runtime == DesktopRuntime::Indeterminate => format!(
            "No reservation is recorded for {desk}, but its runtime state could not be verified. Stopping it interrupts anything running there."
        ),
        Availability::Available => format!("Stopping {desk} interrupts anything running there."),
    }
}

/// What a share link hands over, stated before anyone passes it on.
pub fn link_grant(expires_at: Option<&str>, lease_state: &str) -> String {
    let until = expires_at
        .map(|expiry| format!("until {expiry}"))
        .unwrap_or_else(|| "until it expires".into());
    let caution = if Availability::from_lease(lease_state) == Availability::Available {
        ""
    } else {
        " A chat may be using this desk, so what you do there can interfere with its work."
    };
    format!(
        "This link gives full control of the desk, not just a view: whoever opens it and is approved can see and use it {until}. Treat it like a password.{caution}"
    )
}

/// The outcome of a Stop, including anything that went wrong around it. The
/// runtime itself is shown in the row, never restated here.
pub fn stop_outcome(reservation_verified: bool, interrupted: Option<&str>) -> String {
    match interrupted {
        Some(holder) => format!(
            "Desk stopped, but {holder} reserved it while it was stopping and has been interrupted. Check that chat."
        ),
        None if !reservation_verified => {
            "Desk stopped. Its reservation could not be verified afterwards; refresh before relying on it.".into()
        }
        None => "Desk stopped.".into(),
    }
}

/// The "Held by" cell. Only a desk known to be free shows a dash; an
/// unverified one says so, so it can never read as free.
pub fn held_by(lease_state: &str, holder: Option<&str>) -> String {
    match (holder, Availability::from_lease(lease_state)) {
        (Some(holder), _) => holder.to_owned(),
        (None, Availability::Available) => "—".into(),
        (None, Availability::Reserved) => "A chat".into(),
        (None, _) => "Not verified".into(),
    }
}

/// The owner's "share all desks with all chats" switch, in the words used
/// wherever the owner would otherwise be told to connect a desk to a chat.
pub struct DeskSharing;
impl DeskSharing {
    pub fn summary(shared: bool) -> &'static str {
        if shared {
            "All desks are shared with all chats. Any chat can reserve any desk, one chat at a time, including desks added later."
        } else {
            "Desks are not shared: each chat reaches only the desks listed in its Settings."
        }
    }
    pub fn switch_label(shared: bool) -> &'static str {
        if shared {
            "Stop sharing desks with all chats"
        } else {
            "Share all desks with all chats"
        }
    }
    pub fn inventory_help(shared: bool) -> &'static str {
        if shared {
            "All desk resources, shared with all chats. Start, stop or link a desk here, or reserve it for any chat."
        } else {
            "All desk resources. Start, stop or link a desk here, or reserve it from a connected chat."
        }
    }
    pub fn reserve_title(shared: bool) -> &'static str {
        if shared {
            "Reserve for a chat"
        } else {
            "Reserve from a connected chat"
        }
    }
    /// A chat without a binding has no V1 thread to hold a desk with yet.
    pub fn chat_help(shared: bool, bound: bool) -> &'static str {
        if shared && !bound {
            "All desks are shared with all chats. Save this chat's V1 thread below so its workers can reserve them."
        } else if shared {
            "All desks are shared with all chats: workers of this chat may reserve any desk, one chat at a time. Open or reserve any desk from Virtual desks. Listing desks here is optional."
        } else {
            "Workers of this chat may lease these V1 desktops. Every desktop must be granted to the V1 thread in V1."
        }
    }
    pub fn slugs_label(shared: bool) -> &'static str {
        if shared {
            "Desktops (optional, all desks are shared)"
        } else {
            "Desktops"
        }
    }
}

/// One line above the table, so the rows themselves stay short.
pub const LEGEND: &str = "Available: no reservation at the last refresh. Reserved: a chat holds the desk for a step or between its steps, it was handed to you, or you are viewing it. Not verified or needs checking: it could not be confirmed, which does not mean the desk is free. Hover a status for details.";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_unreserved_means_available() {
        assert_eq!(
            Availability::from_lease("unreserved"),
            Availability::Available
        );
        for state in ["unknown", "running", "ready", "", "future-state"] {
            assert_eq!(Availability::from_lease(state), Availability::Unknown);
        }
        for state in ["expired", "stale"] {
            assert_eq!(Availability::from_lease(state), Availability::NeedsCheck);
        }
        assert_eq!(Availability::from_lease("reserved"), Availability::Reserved);
    }
    #[test]
    fn stop_warnings_name_what_is_interrupted_and_never_read_as_free() {
        let running = DesktopRuntime::Running;
        let reserved = stop_warning(
            "Desk A",
            "reserved",
            Some("Chat one"),
            Some("10:00"),
            running,
        );
        assert!(reserved.contains("Chat one has Desk A reserved until 10:00"));
        assert!(reserved.contains("interrupts"));
        let stale = stop_warning("Desk A", "stale", Some("Chat one"), None, running);
        assert!(stale.contains("Chat one") && stale.contains("may still be using it"));
        let unknown = stop_warning("Desk A", "unknown", None, None, running);
        assert!(unknown.contains("could not be verified") && unknown.contains("may be using it"));
        let unverified = stop_warning(
            "Desk A",
            "unreserved",
            None,
            None,
            DesktopRuntime::Indeterminate,
        );
        assert!(unverified.contains("runtime state could not be verified"));
    }
    #[test]
    fn a_link_is_described_as_full_control_with_its_expiry() {
        let text = link_grant(Some("11:00"), "unreserved");
        assert!(text.contains("full control") && text.contains("until 11:00"));
        assert!(!text.contains("interfere"));
        assert!(link_grant(None, "unreserved").contains("until it expires"));
        for lease in ["reserved", "stale", "unknown"] {
            assert!(link_grant(None, lease).contains("interfere with its work"));
        }
    }
    #[test]
    fn a_stop_outcome_never_hides_an_interruption() {
        assert_eq!(stop_outcome(true, None), "Desk stopped.");
        let interrupted = stop_outcome(true, Some("Chat two"));
        assert!(interrupted.contains("Chat two") && interrupted.contains("interrupted"));
        assert!(stop_outcome(false, None).contains("could not be verified"));
        // The Runtime cell is the only place the runtime is shown.
        assert!(!stop_outcome(true, None).contains("Runtime"));
    }
    #[test]
    fn only_a_known_free_desk_is_held_by_nobody() {
        assert_eq!(held_by("unreserved", None), "—");
        assert_eq!(held_by("reserved", Some("Chat one")), "Chat one");
        assert_eq!(held_by("reserved", None), "A chat");
        for lease in ["unknown", "stale", "expired", "", "future-state"] {
            assert_eq!(held_by(lease, None), "Not verified", "{lease}");
        }
        assert!(LEGEND.contains("does not mean the desk is free"));
    }
    #[test]
    fn only_a_free_desk_gets_the_available_style() {
        assert_eq!(Availability::from_lease("unreserved").token(), "available");
        assert_eq!(Availability::from_lease("nonsense").token(), "unknown");
        assert_eq!(Availability::from_lease("stale").token(), "needs-check");
    }
    #[test]
    fn shared_desks_never_ask_to_connect_a_desk_to_a_chat() {
        for text in [
            DeskSharing::summary(true),
            DeskSharing::inventory_help(true),
            DeskSharing::reserve_title(true),
            DeskSharing::chat_help(true, true),
            DeskSharing::chat_help(true, false),
            DeskSharing::slugs_label(true),
        ] {
            assert!(!text.contains("connected"), "{text}");
            assert!(!text.contains("granted to the V1 thread"), "{text}");
        }
        assert!(DeskSharing::summary(true).contains("shared with all chats"));
        assert!(DeskSharing::chat_help(true, true).contains("any desk"));
        assert!(DeskSharing::chat_help(true, false).contains("V1 thread below"));
        assert!(DeskSharing::chat_help(false, true).contains("granted to the V1 thread in V1"));
        assert_ne!(
            DeskSharing::switch_label(true),
            DeskSharing::switch_label(false)
        );
    }
    fn desk(
        lease_state: &str,
        claim: Option<(DesktopReservationKind, &str)>,
        viewer: bool,
    ) -> DesktopResource {
        let view =
            |kind, chat: Option<&str>, until_ms| orkestr_v2_contracts::DesktopReservationView {
                desk: "desk-a".into(),
                kind,
                chat: chat.map(str::to_owned),
                mine: false,
                conversation_id: None,
                since_ms: 0,
                until_ms,
                reserved_until_ms: None,
            };
        DesktopResource {
            slug: "desk-a".into(),
            label: "Desk A".into(),
            state: "running".into(),
            lease_state: lease_state.into(),
            holder: None,
            expires_at: None,
            reservation: claim.map(|(kind, chat)| view(kind, Some(chat), 60_000)),
            owner_viewer: viewer.then(|| view(DesktopReservationKind::OwnerViewer, None, 120_000)),
        }
    }
    #[test]
    fn a_desk_reserved_between_steps_never_looks_free() {
        let clock = |ms: i64| format!("t{}", ms / 60_000);
        let free = desk("unreserved", None, false);
        assert_eq!(shown_lease_state(&free), "unreserved");
        assert_eq!(shown_holder(&free), None);
        assert!(reservation_lines(&free, clock).is_empty());
        let task = desk(
            "unreserved",
            Some((DesktopReservationKind::Task, "Chat one")),
            false,
        );
        assert_eq!(
            Availability::from_lease(shown_lease_state(&task)),
            Availability::Reserved
        );
        assert_eq!(shown_holder(&task).as_deref(), Some("Chat one"));
        assert_eq!(
            reservation_lines(&task, clock),
            vec!["Chat task · Chat one · until t1"]
        );
        let handed = desk(
            "unreserved",
            Some((DesktopReservationKind::OwnerHandoff, "Chat one")),
            true,
        );
        assert_eq!(
            reservation_lines(&handed, clock),
            vec![
                "Handed to you · by Chat one · until t1",
                "Your viewing link · you · until t2"
            ]
        );
        assert!(free_desk_help(&handed).contains("hand-over"));
        assert!(free_desk_help(&task).contains("chat's reservation"));
        assert!(END_VIEWING_HELP.contains("link stops working"));
        assert!(viewer_not_recorded(
            &serde_json::json!({"url":"x","viewer_recorded":false})
        ));
        assert!(!viewer_not_recorded(
            &serde_json::json!({"url":"x","viewer_recorded":true})
        ));
        assert!(
            !viewer_not_recorded(&serde_json::json!({"url":"x"})),
            "an older server never warns"
        );
        let viewed = desk("unknown", None, true);
        assert_eq!(shown_lease_state(&viewed), "reserved");
        assert_eq!(shown_holder(&viewed).as_deref(), Some("You (viewing)"));
        assert!(stop_needs_confirmation_shown(&task));
    }
    fn stop_needs_confirmation_shown(desk: &DesktopResource) -> bool {
        orkestr_v2_contracts::stop_needs_confirmation(
            shown_lease_state(desk),
            DesktopRuntime::Running,
        )
    }
    #[test]
    fn unknown_reservations_have_explicit_check_action() {
        assert_eq!(Availability::Unknown.reserve_label(), "Check & reserve");
        assert!(Availability::Unknown
            .explanation()
            .contains("does not mean the desk is free"));
    }
}
