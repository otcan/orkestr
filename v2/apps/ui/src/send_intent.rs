//! A Send gesture admits only its own validated saved message, never an older queue row.
use crate::{beta_inputs::SavedInput, beta_window::valid_status};
use orkestr_v2_contracts::{ExecutionWindowRequest, ExecutionWindowState, ExecutionWindowStatus};

pub fn same_input(request: &ExecutionWindowRequest, input: &SavedInput) -> bool {
    request.input_message_id == input.receipt.message_id
        && request.input_event_id == input.receipt.event_id
        && request.input_request_key == input.input_request_key
}

pub fn prepare(
    input: &SavedInput,
    current: Option<&ExecutionWindowStatus>,
    key: String,
) -> Result<ExecutionWindowRequest, &'static str> {
    if current.is_some_and(|s| !valid_status(s, &input.conversation.to_string())) {
        return Err("Work status could not be verified. Your message remains saved.");
    }
    if current.is_some_and(|s| {
        !matches!(
            s.state,
            ExecutionWindowState::Active | ExecutionWindowState::Closed
        )
    }) {
        return Err("Previous work is still closing or needs attention. Your message is saved; retry when it is ready.");
    }
    let request = ExecutionWindowRequest {
        request_key: key,
        input_message_id: input.receipt.message_id.clone(),
        input_event_id: input.receipt.event_id.clone(),
        input_request_key: input.input_request_key.clone(),
        expected_generation: current.map_or(0, |s| s.generation),
        window_id: current
            .filter(|s| s.state == ExecutionWindowState::Active)
            .map(|s| s.window_id),
        predecessor_window_id: current
            .filter(|s| s.state == ExecutionWindowState::Closed)
            .map(|s| s.window_id),
    };
    if !request.is_valid() {
        return Err("Send could not be prepared. Your message remains saved.");
    }
    Ok(request)
}
