//! One capacity fallback retry inside the same durable run.
//!
//! A Codex turn that ends with the broker's closed `capacity` class is
//! withheld from Core. When the broker proved the turn made no tool call and
//! no side-effecting item, and Runtime's own channel routed no tool call or
//! steer, the very same turn is submitted once more on the same native thread
//! with the configured fallback model. Every byte still passes the original
//! run's durable dispatch fence, so a cancelled or fenced run cannot retry.
//! Anything else delivers the closed `provider` failure; nothing else retries.
use super::pump::{native_model_evidence, CodexOutput};
use crate::{
    capacity_fallback::{self, CapacityFallback},
    containment::{ConsumedTurn, ExecutionScope},
    ports::Blocker,
};
use serde_json::{json, Value};

/// Prefixed to the retried input. The failed attempt's input is already in
/// the native thread's history; the note says why it appears again.
/// Kept short: Fast turns carry a bounded input budget.
pub(crate) fn retry_note(from: &str, to: &str, stalled: bool) -> String {
    let cause = if stalled {
        "slow/overloaded"
    } else {
        "at capacity"
    };
    format!(
        "[Orkestr retry on {to}: {from} was {cause} before any work. Answer the message below.]"
    )
}

/// Retained by the pump for its one possible retry. Never a Core grant: the
/// frame only repeats bytes the consumed capability already authorized.
#[derive(Default)]
pub(super) struct CapacityRetry {
    policy: Option<CapacityFallback>,
    frame: Option<Value>,
    actual_fd: bool,
    attempted: bool,
    stall_fired: bool,
    /// The native thread default before a fallback override: Codex keeps a
    /// turn override for later turns, so the next default turn restores it.
    pub(super) restore_model: Option<String>,
}

impl CapacityRetry {
    pub(super) fn new(policy: CapacityFallback, frame: &Value, actual_fd: bool) -> Self {
        Self {
            policy: Some(policy),
            frame: Some(frame.clone()),
            actual_fd,
            attempted: false,
            stall_fired: false,
            restore_model: None,
        }
    }
    /// A committed stop owns the run now: never retry it.
    pub(super) fn abandon(&mut self) {
        self.attempted = true;
        self.stall_fired = true;
        self.frame = None;
    }
    #[cfg(test)]
    pub(super) fn set_policy(&mut self, policy: CapacityFallback) {
        self.policy = Some(policy);
    }
    #[cfg(test)]
    pub(super) fn attempted(&self) -> bool {
        self.attempted
    }
}

/// Sealed same-run resubmission: the scope and fence are the original run's.
struct FallbackTurn {
    scope: ExecutionScope,
    bytes: Vec<u8>,
    lineage: Option<std::sync::Arc<()>>,
}
impl ConsumedTurn for FallbackTurn {
    fn broker_lineage(&self) -> Option<std::sync::Arc<()>> {
        self.lineage.clone()
    }
    fn into_submission(self) -> (ExecutionScope, Vec<u8>) {
        (self.scope, self.bytes)
    }
}

/// A fresh client message id derived from the original: UUID shaped when the
/// original is a UUID, so the native peer never sees a duplicate id.
fn retry_message_id(original: &str) -> String {
    let hex: String = original.chars().filter(|c| *c != '-').collect();
    match u128::from_str_radix(&hex, 16) {
        Ok(value) if hex.len() == 32 => {
            let mut value = value ^ 0x00c0_ffee_0000_0000_0000_0000_0fa1_1bac;
            value = (value & !(0xf_u128 << 76)) | (0x4_u128 << 76);
            value = (value & !(0x3_u128 << 62)) | (0x2_u128 << 62);
            let s = format!("{value:032x}");
            format!(
                "{}-{}-{}-{}-{}",
                &s[0..8],
                &s[8..12],
                &s[12..16],
                &s[16..20],
                &s[20..32]
            )
        }
        _ => format!("{original}:capacity-fallback"),
    }
}

pub(super) fn retry_frame(
    original: &Value,
    request: u64,
    from: &str,
    to: &str,
    stalled: bool,
) -> Result<Value, Blocker> {
    let mut frame = original.clone();
    if frame.get("method").and_then(Value::as_str) != Some("turn/start") {
        return Err(Blocker::Protocol);
    }
    let params = frame
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .ok_or(Blocker::Protocol)?;
    let message = params
        .get("clientUserMessageId")
        .and_then(Value::as_str)
        .ok_or(Blocker::Protocol)?
        .to_owned();
    params.insert(
        "clientUserMessageId".into(),
        json!(retry_message_id(&message)),
    );
    params.insert("model".into(), json!(to));
    let text = params
        .get_mut("input")
        .and_then(|input| input.get_mut(0))
        .and_then(|item| item.get_mut("text"))
        .ok_or(Blocker::Protocol)?;
    let original_text = text.as_str().ok_or(Blocker::Protocol)?;
    *text = json!(format!(
        "{}\n\n{original_text}",
        retry_note(from, to, stalled)
    ));
    frame["id"] = json!(request);
    Ok(frame)
}

impl CodexOutput {
    /// Called whenever the stream may hold a capacity terminal. Either starts
    /// the one fallback turn (no event for Core) or releases the terminal.
    pub(super) fn resolve_capacity(&mut self) -> Result<(), Blocker> {
        let Some(clean) = self.stream.capacity_held() else {
            return Ok(());
        };
        if self.stream.stall_reply_pending() {
            // The interrupt reply still occupies the channel: decide after it.
            return Ok(());
        }
        let role = self.admission.role;
        let policy = self.capacity.policy.clone().unwrap_or_default();
        let (from, to) = self.fallback_pair(&policy);
        let side_effect_free = clean
            && self.steering.is_none()
            && self.tool_write.is_none()
            && self.workspace_write.is_none()
            && self.writing.is_none()
            && self
                .broker
                .as_ref()
                .is_none_or(|channel| channel.turn_side_effect_free());
        let outcome = if !policy.enabled_for(role) {
            "not_retried_disabled"
        } else if !side_effect_free {
            "not_retried_side_effects"
        } else if self.capacity.attempted {
            "not_retried_fallback_exhausted"
        } else if from.is_none() {
            "not_retried_unknown_model"
        } else if to.is_none() {
            "not_retried_no_fallback_model"
        } else if self.capacity.frame.is_none() {
            "not_retried_no_retained_turn"
        } else {
            let (from, to) = (from.clone().unwrap(), to.clone().unwrap());
            match self.start_fallback(&from, &to) {
                Ok(()) => "retried_on_fallback",
                Err(_) => "retry_submission_refused",
            }
        };
        self.log_capacity(outcome, from.as_deref(), to.as_deref());
        if outcome == "retried_on_fallback" {
            return Ok(());
        }
        self.stream.release_capacity_hold()
    }

    /// The failing model of the current turn and its configured fallback.
    fn fallback_pair(&self, policy: &CapacityFallback) -> (Option<String>, Option<String>) {
        let requested = self
            .capacity
            .frame
            .as_ref()
            .and_then(|frame| frame.pointer("/params/model"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let from = self
            .stream
            .current_model()
            .map(str::to_owned)
            .or(requested)
            .or_else(|| self.native_model.clone());
        let to = from
            .as_deref()
            .and_then(|from| policy.fallback_for(self.admission.role, from))
            .map(str::to_owned);
        (from, to)
    }

    /// Stall watchdog: Codex sleeps for the provider's Retry-After (minutes)
    /// before it reports a 429. A turn that produced no model item within the
    /// role's deadline and made no tool call or steer is interrupted by
    /// Runtime itself; its `interrupted` terminal is then held exactly like a
    /// capacity failure and retried once on the fallback.
    pub(super) fn check_stall(&mut self) -> Result<(), Blocker> {
        let Some(policy) = self.capacity.policy.as_ref() else {
            return Ok(());
        };
        let Some(after) = policy.stall_after(self.admission.role) else {
            return Ok(());
        };
        if self.capacity.attempted
            || self.capacity.stall_fired
            || self.capacity.frame.is_none()
            || self
                .stream
                .started_at()
                .is_none_or(|started| started.elapsed() < after)
            || self.writing.is_some()
            || self.steering.is_some()
            || self.tool_write.is_some()
            || self.workspace_write.is_some()
            || !self.stream.stalled_candidate()
            || !self
                .broker
                .as_ref()
                .is_some_and(|channel| channel.stall_interruptible())
        {
            return Ok(());
        }
        let policy = policy.clone();
        let (from, to) = self.fallback_pair(&policy);
        if to.is_none() {
            // Nothing to retry on: interrupting would only lose the turn.
            return Ok(());
        }
        self.capacity.stall_fired = true;
        // A protocol-only id distinct from a Core stop's interrupt id.
        let request = (1_u64 << 53) - 2;
        let frame = self.stream.claim_stall_interrupt(request)?;
        let writing = if self.capacity.actual_fd {
            Some(super::provider_write::PendingWrite::new(&frame)?)
        } else {
            None
        };
        let channel = self.broker.as_mut().ok_or(Blocker::Protocol)?;
        let sent = channel.cancellation(frame).and_then(|(lineage, bytes)| {
            self.child
                .enqueue_stall_interrupt(&self.scope, &lineage, &bytes)
                .map_err(|_| Blocker::Protocol)
        });
        if let Err(error) = sent {
            self.log_capacity("stall_interrupt_refused", from.as_deref(), to.as_deref());
            self.failed = Some(error.clone());
            self.child.quarantine();
            return Err(error);
        }
        self.writing = writing;
        self.log_capacity("stalled_interrupted", from.as_deref(), to.as_deref());
        Ok(())
    }

    fn start_fallback(&mut self, from: &str, to: &str) -> Result<(), Blocker> {
        let stalled = self.stream.stall_interrupt().is_some();
        let original = self.capacity.frame.as_ref().ok_or(Blocker::Protocol)?;
        let request = self
            .stream
            .request()
            .checked_add(1)
            .ok_or(Blocker::Protocol)?;
        let mut next = self.stream.fallback_retry(request)?;
        let frame = retry_frame(original, request, from, to, stalled)?;
        let writing = if self.capacity.actual_fd {
            Some(super::provider_write::PendingWrite::new(&frame)?)
        } else {
            None
        };
        // From here every refusal leaves the channel unusable for this run;
        // the caller delivers the original provider failure instead.
        self.capacity.attempted = true;
        let (bytes, lineage) = match self.broker.as_mut() {
            Some(channel) => {
                let envelope = channel.reserve_continuation(request)?;
                let lineage = envelope.lineage.clone();
                (envelope.wrap(frame.clone()), Some(lineage))
            }
            None => (frame.to_string().into_bytes(), None),
        };
        self.child
            .enqueue_turn(FallbackTurn {
                scope: self.scope.clone(),
                bytes,
                lineage,
            })
            .map_err(|_| Blocker::Protocol)?;
        next.report_model(native_model_evidence(
            self.native_model.as_deref(),
            Some(to),
        ));
        // Codex keeps a turn override for later turns: the next turn that
        // has no owner model asks for the model this turn started on again.
        self.capacity.restore_model = Some(from.to_owned());
        self.writing = writing;
        self.stream = next;
        Ok(())
    }

    fn log_capacity(&self, outcome: &'static str, from: Option<&str>, to: Option<&str>) {
        capacity_fallback::log(
            outcome,
            self.admission.role,
            &self.admission.run_id.to_string(),
            &self.admission.conversation_id.to_string(),
            from,
            to,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> Value {
        json!({"id":4,"method":"turn/start","params":{"threadId":"native",
            "clientUserMessageId":"0b6a7c62-3c53-4f0e-9a51-41d9b2d0f1aa",
            "input":[{"type":"text","text":"original input","text_elements":[]}]}})
    }

    #[test]
    fn retry_frame_keeps_thread_and_input_with_a_new_id_model_and_note() {
        let retry = retry_frame(&frame(), 5, "gpt-6.1-sol", "gpt-6-sol", false).unwrap();
        assert_eq!(retry["id"], 5);
        assert_eq!(retry["params"]["threadId"], "native");
        assert_eq!(retry["params"]["model"], "gpt-6-sol");
        let id = retry["params"]["clientUserMessageId"].as_str().unwrap();
        assert_ne!(id, "0b6a7c62-3c53-4f0e-9a51-41d9b2d0f1aa");
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        let text = retry["params"]["input"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("[Orkestr retry on gpt-6-sol: gpt-6.1-sol was at capacity"));
        assert!(retry_note("a", "b", true).contains("slow/overloaded"));
        assert!(retry_note("gpt-6.1-sol", "gpt-6-sol", true).len() < 120);
        assert!(text.contains("gpt-6.1-sol") && text.contains("gpt-6-sol"));
        assert!(text.ends_with("\n\noriginal input"));
        assert_eq!(retry["params"].as_object().unwrap().len(), 4);
        // Same derivation every time; never the original.
        assert_eq!(retry_message_id("0b6a7c62-3c53-4f0e-9a51-41d9b2d0f1aa"), id);
        assert_eq!(retry_message_id("plain"), "plain:capacity-fallback");
    }

    #[test]
    fn retry_frame_replaces_an_explicit_override_and_refuses_other_methods() {
        let mut original = frame();
        original["params"]["model"] = json!("gpt-6.1-sol");
        original["params"]["effort"] = json!("high");
        let retry = retry_frame(&original, 5, "gpt-6.1-sol", "gpt-6-sol", false).unwrap();
        assert_eq!(retry["params"]["model"], "gpt-6-sol");
        assert_eq!(retry["params"]["effort"], "high");
        original["method"] = json!("turn/steer");
        assert!(retry_frame(&original, 5, "a", "b", true).is_err());
    }
}
