//! Operator-pinned authority/executor identities; never an HTTP capability.
use serde::Deserialize;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentitySplit {
    pub authority_uid: u32,
    pub executor_uid: u32,
    pub shared_gid: u32,
}
impl IdentitySplit {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if self.authority_uid == 0
            || self.executor_uid == 0
            || self.shared_gid == 0
            || self.authority_uid == self.executor_uid
            || [self.authority_uid, self.executor_uid, self.shared_gid]
                .iter()
                .any(|id| *id >= 1 << 31)
        {
            return Err("invalid split service identity");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_remains_default_and_equal_or_root_identities_are_refused() {
        for (authority, executor, gid) in
            [(0, 20001, 20001), (20001, 20001, 20001), (20000, 20001, 0)]
        {
            assert!(
                IdentitySplit {
                    authority_uid: authority,
                    executor_uid: executor,
                    shared_gid: gid
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            IdentitySplit {
                authority_uid: 20000,
                executor_uid: 20001,
                shared_gid: 20001
            }
            .validate()
            .is_ok()
        );
    }
    #[test]
    fn existing_privileged_host_mode_is_not_silently_downgraded_by_a_split() {
        let mut value = serde_json::json!({"schema_version":1,"owner_id":uuid::Uuid::new_v4(),
            "conversation_id":uuid::Uuid::new_v4(),"manager_socket":"/run/example/control.sock",
            "launcher":"/opt/example/launcher.py","launcher_sha256":"a".repeat(64),
            "workspace":"/srv/example/workspace","namespace":"example","supervisor_key":"example"});
        let legacy: crate::beta_config::BetaConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(legacy.identity_split.is_none());
        assert!(legacy.validate().is_ok());
        value["identity_split"] =
            serde_json::json!({"authority_uid":20000,"executor_uid":20001,"shared_gid":20001});
        let split: crate::beta_config::BetaConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(split.validate().is_ok());
        value["host_full_access"] = serde_json::json!({"providers":true,"environment":{"HOME":"/srv/example/provider","PATH":"/usr/bin:/bin"}});
        let unsupported: crate::beta_config::BetaConfig = serde_json::from_value(value).unwrap();
        assert!(matches!(
            unsupported.validate(),
            Err("unsupported split execution mode")
        ));
    }
}
