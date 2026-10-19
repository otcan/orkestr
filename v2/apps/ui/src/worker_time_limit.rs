//! Explicit owner budget choices. These never calculate a host deadline.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimeLimit {
    #[default]
    Default30Seconds,
    OneMinute,
    FiveMinutes,
    FifteenMinutes,
}
impl TimeLimit {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "default" => Some(Self::Default30Seconds),
            "60000" => Some(Self::OneMinute),
            "300000" => Some(Self::FiveMinutes),
            "900000" => Some(Self::FifteenMinutes),
            _ => None,
        }
    }
    pub fn value(self) -> &'static str {
        match self {
            Self::Default30Seconds => "default",
            Self::OneMinute => "60000",
            Self::FiveMinutes => "300000",
            Self::FifteenMinutes => "900000",
        }
    }
    pub fn budget_ms(self) -> Option<u32> {
        match self {
            Self::Default30Seconds => None,
            Self::OneMinute => Some(60_000),
            Self::FiveMinutes => Some(300_000),
            Self::FifteenMinutes => Some(900_000),
        }
    }
}
