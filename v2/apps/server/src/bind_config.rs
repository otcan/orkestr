use std::net::{IpAddr, Ipv4Addr, SocketAddr};

pub(crate) struct BindConfig {
    pub bind: SocketAddr,
    pub origin: String,
}

impl BindConfig {
    pub fn parse(
        bind: Option<&str>,
        container: Option<&str>,
        origin: Option<&str>,
    ) -> Result<Self, &'static str> {
        if container.is_some_and(|value| value != "1") {
            return Err("ORKESTR_V2_CONTAINER_BIND must be exactly 1 when set");
        }
        let bind: SocketAddr = bind
            .unwrap_or("127.0.0.1:19822")
            .parse()
            .map_err(|_| "invalid bind address")?;
        if !bind.ip().is_loopback()
            && !(container == Some("1") && bind.ip() == IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        {
            return Err("nonloopback binding requires explicit IPv4 container opt-in");
        }
        if !bind.ip().is_loopback() && origin.is_none() {
            return Err("container binding requires explicit ORKESTR_V2_ORIGIN");
        }
        let origin = origin
            .map(str::to_owned)
            .unwrap_or_else(|| format!("http://{bind}"));
        let uri: axum::http::Uri = origin.parse().map_err(|_| "invalid origin")?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
            || origin.ends_with('/')
            || uri.authority().is_none_or(|a| a.as_str().contains('@'))
            || matches!(uri.host(), Some("0.0.0.0" | "[::]"))
        {
            return Err("explicit origin must identify an http(s) client authority without path");
        }
        Ok(Self { bind, origin })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_defaults_and_exact_container_origin() {
        let native = BindConfig::parse(None, None, None).unwrap();
        assert_eq!(native.bind.to_string(), "127.0.0.1:19822");
        assert_eq!(native.origin, "http://127.0.0.1:19822");
        assert!(BindConfig::parse(Some("[::1]:19822"), None, None).is_ok());
        let configured = BindConfig::parse(
            Some("0.0.0.0:19822"),
            Some("1"),
            Some("https://app.example.test:8443"),
        )
        .unwrap();
        assert_eq!(configured.origin, "https://app.example.test:8443");
    }

    #[test]
    fn all_nonloopback_alternatives_and_unknown_opt_ins_refused() {
        for opt in ["", "0", "true", "yes", " 1", "1 "] {
            assert!(BindConfig::parse(None, Some(opt), None).is_err());
        }
        for bind in [
            "0.0.0.0:19822",
            "[::]:19822",
            "192.0.2.1:19822",
            "not-an-address",
        ] {
            assert!(BindConfig::parse(Some(bind), None, Some("https://app.example.test")).is_err());
        }
        for bind in ["[::]:19822", "192.0.2.1:19822"] {
            assert!(
                BindConfig::parse(Some(bind), Some("1"), Some("https://app.example.test")).is_err()
            );
        }
        assert!(BindConfig::parse(Some("0.0.0.0:19822"), Some("1"), None).is_err());
    }

    #[test]
    fn malformed_or_wildcard_origins_refused() {
        for origin in [
            "",
            "app.example.test",
            "ftp://app.example.test",
            "https://app.example.test/",
            "https://app.example.test/path",
            "https://app.example.test?x=1",
            "https://user@app.example.test",
            "http://0.0.0.0:19822",
            "http://[::]:19822",
        ] {
            assert!(
                BindConfig::parse(Some("0.0.0.0:19822"), Some("1"), Some(origin)).is_err(),
                "{origin}"
            );
        }
    }
}
