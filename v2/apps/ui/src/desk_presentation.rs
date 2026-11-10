//! Owner inventory labels. Runtime health is never evidence of availability.
use orkestr_v2_contracts::DesktopRuntime;

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

/// One line above the table, so the rows themselves stay short.
pub const LEGEND: &str = "Available: no reservation at the last refresh. Reserved: a chat holds the desk. Not verified or needs checking: it could not be confirmed, which does not mean the desk is free. Hover a status for details.";

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
    fn unknown_reservations_have_explicit_check_action() {
        assert_eq!(Availability::Unknown.reserve_label(), "Check & reserve");
        assert!(Availability::Unknown
            .explanation()
            .contains("does not mean the desk is free"));
    }
}
