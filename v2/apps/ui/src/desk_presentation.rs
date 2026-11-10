//! Owner inventory labels. Runtime health is never evidence of availability.
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
}

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
    fn unknown_reservations_have_explicit_check_action() {
        assert_eq!(Availability::Unknown.reserve_label(), "Check & reserve");
        assert!(Availability::Unknown
            .explanation()
            .contains("does not mean the desk is free"));
    }
}
