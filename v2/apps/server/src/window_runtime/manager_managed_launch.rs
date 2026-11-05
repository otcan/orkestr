//! Typed one-use split launch; legacy broker binding remains unchanged.
use super::*;

impl ManagerClient {
    /// Blocking setup worker ONLY, before FD3 receive/FD4 bootstrap. Never call
    /// from an async executor thread. The opaque locator is not signal authority.
    pub fn bind_child(
        &self,
        request_id: &str,
        window: &Window,
        child: &BrokerChildLocator,
        deadline: Instant,
    ) -> Result<BindAck> {
        let managed = child.take_managed().map_err(|_| ManagerError::Protocol)?;
        let mut request = if let Some(descriptors) = &managed {
            let mut request = self.request("launch_child", request_id, Some(window))?;
            request["role"] = json!(descriptors.role());
            request["mode"] = json!(descriptors.mode());
            request["preferences"] = descriptors.preferences();
            if descriptors.workspace_worker() {
                request["workspace_worker"] = json!(true);
            }
            request["setup"] = descriptors
                .setup()
                .map_err(|_| ManagerError::Protocol)?
                .clone();
            request["proxy_pid"] = json!(child.pid());
            request["proxy_start"] = json!(child.start());
            request
        } else {
            self.binding(request_id, window, child.pid(), child.start())?
        };
        request["bind_deadline_ms"] = json!(bind_deadline_ms(deadline)?);
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .map_err(|_| ManagerError::Unavailable)?
            .block_on(async {
                let (value, _) = self
                    .exchange_with_descriptors(
                        request,
                        deadline,
                        managed.as_ref().map(|m| m.descriptors()),
                    )
                    .await?;
                success_fields(
                    &value,
                    Some(if managed.is_some() {
                        "launch"
                    } else {
                        "fresh_child"
                    }),
                )?;
                let receipt = self.window_receipt(&value["receipt"], window)?;
                if receipt.state != WindowState::Active {
                    return Err(ManagerError::Protocol);
                }
                let fresh_child = if let Some(descriptors) = &managed {
                    let launch = &value["launch"];
                    if launch["state"] != "spawned"
                        || launch["role"] != descriptors.role()
                        || launch["proxy_pid"].as_u64() != Some(u64::from(child.pid()))
                        || launch["proxy_start"].as_u64() != Some(child.start())
                        || launch["window_id"] != window.window_id.to_string()
                        || launch["generation"].as_u64() != Some(window.generation)
                        || !launch["broker_pid"]
                            .as_u64()
                            .is_some_and(|pid| (2..1u64 << 31).contains(&pid))
                        || !launch["broker_start"]
                            .as_u64()
                            .is_some_and(|start| start > 0)
                    {
                        return Err(ManagerError::Protocol);
                    }
                    true
                } else {
                    boolean(&value, "fresh_child")?
                };
                Ok(BindAck {
                    receipt,
                    fresh_child,
                })
            })
    }
}
