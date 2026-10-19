//! Bounded independent configured conversations. Every slot still uses the
//! ordinary Store, provider lifecycle and its exact private operator selection.
use super::{config, Config, ConfiguredExecution, ExecutionTask};
use crate::execution_registry::MAX_EXECUTION_SCOPES;
use orkestr_v2_store_sqlite::Store;
use serde::Deserialize;
use std::{
    collections::HashSet,
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    mode: String,
    configurations: Vec<PathBuf>,
}

pub struct ConfiguredExecutions(Vec<ConfiguredExecution>);
pub struct ExecutionTasks(Vec<ExecutionTask>);

impl ConfiguredExecutions {
    pub fn single(execution: ConfiguredExecution) -> Self {
        Self(vec![execution])
    }

    pub async fn load_set(
        store: &Store,
        home: &Path,
        bind: SocketAddr,
        file: &Path,
    ) -> Result<Self, &'static str> {
        let manifest: Manifest =
            serde_json::from_slice(&config::private_file(file, home, 16 * 1024)?)
                .map_err(|_| "invalid execution set configuration")?;
        if manifest.schema_version != 1
            || manifest.mode != "isolated-acceptance-set-v1"
            || manifest.configurations.is_empty()
            || manifest.configurations.len() > MAX_EXECUTION_SCOPES
        {
            return Err("unsupported execution set configuration");
        }
        // Validate the whole local selection before requesting any supervisor.
        // No entry is executed until all loads and HTTP registrations succeed.
        let mut conversations = HashSet::new();
        let mut identities = HashSet::new();
        let mut configs = Vec::new();
        for path in manifest.configurations {
            let config = Config::load(&path, home, bind)?;
            if !conversations.insert((config.conversation_id.clone(), config.role))
                || !identities.insert((config.namespace.clone(), config.supervisor_key.clone()))
            {
                return Err("duplicate conversation or supervisor in execution set");
            }
            configs.push(config);
        }
        let mut executions = Vec::with_capacity(configs.len());
        for config in configs {
            executions.push(ConfiguredExecution::from_config(store, home, config, true).await?);
        }
        Ok(Self(executions))
    }

    pub fn install_control(
        &self,
        mut state: crate::AppState,
    ) -> Result<crate::AppState, &'static str> {
        for execution in &self.0 {
            state = execution.install_control(state)?;
        }
        Ok(state)
    }

    pub fn start(self) -> ExecutionTasks {
        ExecutionTasks(self.0.into_iter().map(ConfiguredExecution::start).collect())
    }
}

impl ExecutionTasks {
    pub async fn shutdown(self) -> Result<(), &'static str> {
        // Fence every slot immediately; joining an earlier child must never
        // leave another conversation running while its turn waits for cleanup.
        for task in &self.0 {
            let _ = task.shutdown.send(true);
        }
        let mut result = Ok(());
        for task in self.0 {
            if let Err(error) = task.shutdown().await {
                result = Err(error);
            }
        }
        result
    }
}
