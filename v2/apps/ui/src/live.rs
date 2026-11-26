//! The page's live channel (`live_channel.js`, `docs/v2/live-channel.md`).
//! A poller reads its path, then waits here instead of sleeping: the wait
//! ends when the server reports that the path's answer changed, after one
//! slow fallback interval while the channel is down, or after the poller's
//! previous interval against a server without the channel.
use dioxus::prelude::*;
use serde::Deserialize;

/// Why a wait ended, and the path's version to pass to the next wait.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Wake {
    pub reason: String,
    #[serde(default)]
    pub version: u64,
    /// `connecting`, `live`, `degraded` (down; slow fallback polls) or `off`.
    #[serde(default)]
    pub state: String,
}

impl Wake {
    /// The channel is down and waits end on the slow fallback timer.
    pub fn degraded(&self) -> bool {
        self.state == "degraded"
    }
}

/// Defines the page-wide channel once; it connects on [`start`].
pub fn install() {
    let _ = document::eval(include_str!("live_channel.js"));
}

/// Connects the channel now (signed in, or signed in again).
pub fn start() {
    let _ = document::eval("globalThis.orkestrLive?.start(); return null;");
}

fn script(path: &str, since: Option<u64>, legacy_ms: u32, cancellable: bool) -> String {
    let path = serde_json::to_string(path).unwrap_or_else(|_| "\"\"".into());
    let since = since.map_or_else(|| "null".to_string(), |v| v.to_string());
    let stop = if cancellable {
        "const stop=new AbortController();dioxus.recv().then(()=>stop.abort());"
    } else {
        "const stop=new AbortController();"
    };
    format!(
        "{stop}const live=globalThis.orkestrLive;\
         if(!live){{await new Promise(r=>{{const t=setTimeout(r,{legacy_ms});stop.signal.addEventListener('abort',()=>{{clearTimeout(t);r();}});}});return {{reason:'legacy',version:0,live:false,state:'off'}};}}\
         const wake=await live.wait({path},{since},{legacy_ms},stop.signal);\
         return {{...wake,state:live.status().state}};"
    )
}

/// Waits until `path` should be read again. `since`: the version the
/// previous wait returned (`None` on the first). A wait that only reached
/// its upper bound, or only saw the channel recover, is repeated.
pub async fn wait(path: &str, since: Option<u64>, legacy_ms: u32) -> Wake {
    wait_for(path, since, legacy_ms, false).await
}

/// Like [`wait`], but also ends with reason `recovered` when the channel is
/// healthy again (for a reader that shows the channel's state).
pub async fn wait_or_recovered(path: &str, since: Option<u64>, legacy_ms: u32) -> Wake {
    wait_for(path, since, legacy_ms, true).await
}

async fn wait_for(path: &str, mut since: Option<u64>, legacy_ms: u32, recovered: bool) -> Wake {
    loop {
        match document::eval(&script(path, since, legacy_ms, false))
            .join::<Wake>()
            .await
        {
            Ok(wake) if wake.reason == "timeout" || (!recovered && wake.reason == "recovered") => {
                since = Some(wake.version)
            }
            Ok(wake) => return wake,
            Err(_) => {
                crate::transport::sleep(legacy_ms).await;
                return Wake {
                    reason: "legacy".into(),
                    ..Wake::default()
                };
            }
        }
    }
}

/// Like [`wait`], as an eval the caller can end early by sending it any
/// message (a manual refresh); then the wake reason is `aborted`.
pub fn waiting(path: &str, since: Option<u64>, legacy_ms: u32) -> document::Eval {
    document::eval(&script(path, since, legacy_ms, true))
}
