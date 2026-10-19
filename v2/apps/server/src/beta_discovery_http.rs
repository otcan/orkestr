//! Current-owner discovery from trusted startup configuration, never provisioning.
use super::*;
use orkestr_v2_contracts::{
    BetaControls, BetaDiscovery, BetaProvider, BetaRole, ExecutionWindowLimits,
};

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let controller = state.window_controller.as_ref().ok_or(Error(
        StatusCode::NOT_FOUND,
        "beta_unconfigured",
        "Beta execution is not configured",
    ))?;
    let (configured_owner, conversation) = controller.configured_scope();
    if &owner != configured_owner {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "beta_scope",
            "Beta scope unavailable",
        ));
    }
    let window = controller
        .status(&credential, conversation)
        .await
        .map_err(|_| unavailable())?;
    let status = state
        .store
        .execution_status(&owner, conversation)
        .await
        .map_err(|_| unavailable())?;
    let control = state
        .window_handles
        .as_ref()
        .and_then(|handles| handles.snapshot(&owner, conversation))
        .and_then(|scope| scope.control);
    let mut controls = BetaControls {
        stop: false,
        steer: false,
        accept: false,
    };
    if let Some(status) = status {
        controls.accept = status.phase == ExecutionPhase::AwaitingAcceptance;
        if let (Some(run), Some(control)) = (status.run_id, control) {
            controls.stop = control.available(&owner, conversation, &run);
            controls.steer = control.steering_available(&owner, conversation, &run);
        }
    }
    Ok(Json(BetaDiscovery {
        schema_version: 1,
        conversation_id: conversation.clone(),
        provider: BetaProvider::Codex,
        role: BetaRole::Deep,
        controls,
        limits: ExecutionWindowLimits::default(),
        window,
    })
    .into_response())
}

fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "beta_unavailable",
        "Beta discovery unavailable",
    )
}

#[cfg(test)]
#[path = "beta_discovery_http_tests.rs"]
mod tests;
