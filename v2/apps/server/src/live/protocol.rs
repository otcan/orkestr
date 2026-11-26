//! Live channel frames, protocol 1 (`docs/v2/live-channel.md`). The server
//! sends JSON text frames over a WebSocket, or the same JSON as the `data` of
//! a server-sent event named after the frame type. The browser sends frames
//! only over a WebSocket.
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub(crate) const PROTOCOL: u32 = 1;
/// Heartbeat frame and WebSocket ping period. A browser that sees no frame
/// for about two and a half periods treats its channel as stalled.
#[cfg(not(test))]
pub(crate) const HEARTBEAT: Duration = Duration::from_secs(12);
/// Tests see heartbeats (and the session re-check) within their patience.
#[cfg(test)]
pub(crate) const HEARTBEAT: Duration = Duration::from_millis(300);

/// A watched path and the fingerprint of what it answers now: the same weak
/// `ETag` a successful JSON read carries, otherwise `<status>:<digest>`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct Fingerprint {
    pub path: String,
    pub fp: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub(crate) enum Frame {
    /// First frame of every channel.
    Hello {
        v: u32,
        channel: String,
        transport: &'static str,
        heartbeat_ms: u64,
        max_paths: usize,
    },
    /// Liveness, every [`HEARTBEAT`].
    Hb { at_ms: i64 },
    /// Watched paths whose answer changed: refetch them.
    Changed { paths: Vec<Fingerprint> },
    /// Current fingerprints of newly watched paths. `recent`: a change was
    /// committed moments before the first read, so a browser that cannot
    /// compare a fingerprint with the `ETag` it holds refetches once.
    Watching {
        paths: Vec<Fingerprint>,
        recent: bool,
    },
    /// A path this channel does not watch.
    Refused { path: String, reason: &'static str },
    /// The browser session ended; the channel closes.
    Expired {},
    /// The server closes the channel; the browser reconnects.
    Bye { reason: &'static str },
}

impl Frame {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Frame::Hello { .. } => "hello",
            Frame::Hb { .. } => "hb",
            Frame::Changed { .. } => "changed",
            Frame::Watching { .. } => "watching",
            Frame::Refused { .. } => "refused",
            Frame::Expired {} => "expired",
            Frame::Bye { .. } => "bye",
        }
    }
    pub(crate) fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
    /// The channel ends after this frame.
    pub(crate) fn last(&self) -> bool {
        matches!(self, Frame::Expired {} | Frame::Bye { .. })
    }
}

/// What a browser may send over a WebSocket.
#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub(crate) enum ClientFrame {
    /// Start or stop watching paths.
    Watch {
        #[serde(default)]
        add: Vec<String>,
        #[serde(default)]
        remove: Vec<String>,
    },
    /// Counts since the last report: polls made on the fallback timer while
    /// the channel was down, and reconnect attempts.
    Report {
        #[serde(default)]
        fallback_polls: u64,
        #[serde(default)]
        reconnects: u64,
    },
    /// Browser liveness (optional; WebSocket pongs count too).
    Hb {},
}

/// Largest frame a browser may send.
pub(crate) const CLIENT_FRAME_MAX: usize = 64 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_tagged_json() {
        let frame = Frame::Changed {
            paths: vec![Fingerprint {
                path: "/api/v2/sidebar".into(),
                fp: "W/\"0a\"".into(),
            }],
        };
        assert_eq!(
            frame.json(),
            r#"{"t":"changed","paths":[{"path":"/api/v2/sidebar","fp":"W/\"0a\""}]}"#
        );
        assert_eq!(Frame::Expired {}.json(), r#"{"t":"expired"}"#);
        assert!(Frame::Bye { reason: "lifetime" }.last());
        assert!(!Frame::Hb { at_ms: 1 }.last());
    }

    #[test]
    fn client_frames_parse_and_default() {
        let watch: ClientFrame =
            serde_json::from_str(r#"{"t":"watch","add":["/api/v2/sidebar"]}"#).unwrap();
        assert_eq!(
            watch,
            ClientFrame::Watch {
                add: vec!["/api/v2/sidebar".into()],
                remove: vec![]
            }
        );
        let report: ClientFrame = serde_json::from_str(r#"{"t":"report","reconnects":2}"#).unwrap();
        assert_eq!(
            report,
            ClientFrame::Report {
                fallback_polls: 0,
                reconnects: 2
            }
        );
        assert_eq!(
            serde_json::from_str::<ClientFrame>(r#"{"t":"hb"}"#).unwrap(),
            ClientFrame::Hb {}
        );
        assert!(serde_json::from_str::<ClientFrame>(r#"{"t":"other"}"#).is_err());
    }
}
