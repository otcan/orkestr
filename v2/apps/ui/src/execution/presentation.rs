//! Owner-facing execution labels from bounded provider evidence.
/// Short truthful cause for a failed run; never provider text.
pub fn failure_label(class: orkestr_v2_contracts::ExecutionFailureClass) -> &'static str {
    use orkestr_v2_contracts::ExecutionFailureClass as Class;
    match class {
        Class::Policy => "provider policy refusal",
        Class::Authentication => "provider login required",
        Class::Quota => "provider usage limit reached",
        Class::Billing => "provider billing problem",
        Class::Provider => "provider rejected the request",
        Class::Unknown => "provider reported an error",
    }
}
/// Owner-visible notice for a run that ended failed: never a silent pending
/// state. Carries only the closed failure class, never provider text.
pub fn failure_notice(status: &orkestr_v2_contracts::ExecutionStatus) -> Option<String> {
    if matches!(
        status.phase,
        orkestr_v2_contracts::ExecutionPhase::Failed
            | orkestr_v2_contracts::ExecutionPhase::Cancelled
    ) && status
        .failure
        .as_ref()
        .is_some_and(|f| f.class == orkestr_v2_contracts::ExecutionFailureClass::Policy)
    {
        let model = status
            .models
            .as_ref()
            .and_then(|m| m.refused_model.as_deref().or(m.resolved_model.as_deref()))
            .unwrap_or("unreported model");
        return Some(format!(
            "Provider policy refusal from {model}. No fallback answer was accepted."
        ));
    }
    (status.phase == orkestr_v2_contracts::ExecutionPhase::Failed).then(|| {
        let cause = status
            .failure
            .as_ref()
            .map_or("the run ended with an error", |f| failure_label(f.class));
        format!(
            "This reply failed: {cause}. Nothing was accepted. Send your message again to retry."
        )
    })
}

/// Native evidence only; the configured model is never substituted for an answer.
pub fn model_label(status: &orkestr_v2_contracts::ExecutionStatus) -> String {
    let Some(models) = &status.models else {
        return "Answering model unreported".into();
    };
    if let Some(actual) = &models.actual_model {
        return match &models.resolved_model {
            Some(resolved) if resolved != actual => {
                format!("Answered with {actual} (initialized as {resolved})")
            }
            _ => format!("Answered with {actual}"),
        };
    }
    if let Some(refused) = &models.refused_model {
        return format!("Declined by {refused}");
    }
    match &models.resolved_model {
        Some(resolved) => format!("Reported model: {resolved}; answering model unreported"),
        None => "Answering model unreported".into(),
    }
}
