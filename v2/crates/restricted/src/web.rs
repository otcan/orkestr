//! Network access the model can only reach through the broker: `fetch_url` and
//! `web_search` (and the model endpoint itself) go through `curl` with a cleared
//! environment. Fetches resolve the host first, refuse any non-public address and pin
//! the connection to what was checked, so DNS rebinding cannot swap in a private IP.
use crate::exec::run_bounded;
use crate::netcheck::{public_ip, screen};
use async_trait::async_trait;
use std::net::ToSocketAddrs;
use std::process::Command;
use std::time::Duration;

pub const FETCH_CAP: usize = 64 * 1024;

/// A `curl -K -` configuration line value, quoted so secrets and URLs cannot add options.
pub fn curl_quote(value: &str) -> Result<String, String> {
    if value.chars().any(|c| c.is_control()) {
        return Err("control character in curl option".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[async_trait]
pub trait Fetcher: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<String, String>;
}
#[async_trait]
pub trait Searcher: Send + Sync {
    async fn search(&self, query: &str) -> Result<String, String>;
}

pub struct CurlFetcher;
#[async_trait]
impl Fetcher for CurlFetcher {
    async fn fetch(&self, url: &str) -> Result<String, String> {
        let url = url.to_owned();
        tokio::task::spawn_blocking(move || {
            let target = screen(&url)?;
            let addrs: Vec<_> = (target.host.as_str(), target.port)
                .to_socket_addrs()
                .map_err(|_| "could not resolve that host".to_string())?
                .collect();
            if addrs.is_empty() || addrs.iter().any(|a| !public_ip(a.ip())) {
                return Err("that host resolves to a private, local or reserved address".into());
            }
            let pinned = addrs[0].ip();
            let pin = if pinned.is_ipv6() { format!("[{pinned}]") } else { pinned.to_string() };
            let config = format!(
                "url = {}\nresolve = {}\nproto = \"=http,https\"\nmax-redirs = 0\nmax-time = 20\nmax-filesize = 1048576\nsilent\nshow-error\nuser-agent = \"orkestr-restricted/1\"\nwrite-out = \"\\n[http %{{http_code}} %{{redirect_url}}]\"\n",
                curl_quote(&url)?,
                curl_quote(&format!("{}:{}:{}", target.host, target.port, pin))?
            );
            let mut command = Command::new("curl");
            command.args(["-K", "-"]);
            let out = run_bounded(command, Some(config.into_bytes()), Duration::from_secs(25), FETCH_CAP, || {})
                .map_err(|e| format!("could not run curl: {e}"))?;
            if out.status != Some(0) {
                return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect::<String>());
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        })
        .await
        .map_err(|_| "fetch task failed".to_string())?
    }
}

/// SearxNG-style JSON search: `GET <base>?q=...&format=json`.
pub struct JsonSearch {
    pub base: String,
}
#[async_trait]
impl Searcher for JsonSearch {
    async fn search(&self, query: &str) -> Result<String, String> {
        let base = self.base.clone();
        let query = query.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut encoded = String::new();
            for b in query.bytes() {
                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                    encoded.push(b as char);
                } else {
                    encoded.push_str(&format!("%{b:02X}"));
                }
            }
            let sep = if base.contains('?') { '&' } else { '?' };
            let config = format!(
                "url = {}\nmax-time = 20\nmax-filesize = 1048576\nsilent\nshow-error\nfail\n",
                curl_quote(&format!("{base}{sep}q={encoded}&format=json"))?
            );
            let mut command = Command::new("curl");
            command.args(["-K", "-"]);
            let out = run_bounded(
                command,
                Some(config.into_bytes()),
                Duration::from_secs(25),
                1024 * 1024,
                || {},
            )
            .map_err(|e| format!("could not run curl: {e}"))?;
            if out.status != Some(0) {
                return Err("search backend failed".into());
            }
            let json: serde_json::Value = serde_json::from_slice(&out.stdout)
                .map_err(|_| "search backend returned invalid JSON".to_string())?;
            let mut text = String::new();
            for item in json["results"].as_array().into_iter().flatten().take(6) {
                let field = |k: &str| {
                    item[k]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(400)
                        .collect::<String>()
                };
                text.push_str(&format!(
                    "- {}\n  {}\n  {}\n",
                    field("title"),
                    field("url"),
                    field("content")
                ));
            }
            Ok(if text.is_empty() {
                "no results".into()
            } else {
                text
            })
        })
        .await
        .map_err(|_| "search task failed".to_string())?
    }
}

pub struct Unconfigured(pub &'static str);
#[async_trait]
impl Searcher for Unconfigured {
    async fn search(&self, _: &str) -> Result<String, String> {
        Err(format!("{} is not configured on this installation", self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_blocks_option_injection() {
        assert_eq!(curl_quote("a\"b\\c").unwrap(), "\"a\\\"b\\\\c\"");
        assert!(curl_quote("x\noutput = \"/etc/cron.d/x\"").is_err());
    }
    #[tokio::test]
    async fn fetch_refuses_private_targets_before_connecting() {
        for url in [
            "http://127.0.0.1:1/",
            "http://localhost/",
            "file:///etc/passwd",
            "http://169.254.169.254/",
        ] {
            assert!(CurlFetcher.fetch(url).await.is_err(), "{url}");
        }
    }
}
