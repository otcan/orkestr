//! UUID correlation for the one consumed steering frame; never authority.
use super::*;
pub(super) struct Correlation {
    id: String,
    turn: String,
    ack: Option<bool>,
}
impl BrokerChannel {
    pub(crate) fn steering_turn(&self) -> Result<&str, Blocker> {
        if self.poisoned || !self.execution_claimed || self.terminal_observed {
            return Err(Blocker::Protocol);
        }
        self.active_turn.as_deref().ok_or(Blocker::Protocol)
    }
    pub(crate) fn steering(
        &mut self,
        id: String,
        turn: &str,
        frame: Value,
    ) -> Result<(std::sync::Arc<()>, Vec<u8>), Blocker> {
        if self.steering_turn()? != turn
            || self.preparation != Some(Preparation::Written)
            || self.steering.is_some()
            || self.offline.pending.is_some()
            || self.steering_ids.len() >= 128
            || self.steering_ids.contains(&id)
        {
            return Err(Blocker::Protocol);
        }
        let lineage = self.lineage.clone().ok_or(Blocker::Protocol)?;
        let bytes = self.wrap("SteerExecution", frame)?;
        self.steering_ids.insert(id.clone());
        self.steering = Some(Correlation {
            id,
            turn: turn.to_owned(),
            ack: None,
        });
        Ok((lineage, bytes))
    }
    pub(super) fn receive_steering(&mut self, frame: &Value) -> Result<(), Blocker> {
        let correlation = self.steering.as_mut().ok_or(Blocker::Protocol)?;
        if frame.as_object().is_none_or(|v| v.len() != 2)
            || frame.get("id").and_then(Value::as_str) != Some(&correlation.id)
            || correlation.ack.is_some()
        {
            return Err(Blocker::Protocol);
        }
        let result = frame
            .get("result")
            .and_then(Value::as_object)
            .ok_or(Blocker::Protocol)?;
        if result.len() != 1
            || result.get("turnId").and_then(Value::as_str) != Some(&correlation.turn)
        {
            // Unknown/error shapes never become an acknowledgement or a retry.
            return Err(Blocker::Protocol);
        }
        correlation.ack = Some(true);
        Ok(())
    }
    pub(crate) fn steering_ack_ready(&self) -> bool {
        self.steering.as_ref().is_some_and(|s| s.ack.is_some())
    }
    pub(crate) fn take_steering_ack(&mut self) -> Option<bool> {
        if !self.steering_ack_ready() {
            return None;
        }
        self.steering.take().and_then(|s| s.ack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn running() -> BrokerChannel {
        let mut c = OwnedMetadataHandle {
            _handle: "synthetic_owned".into(),
            lineage: Some(std::sync::Arc::new(())),
        }
        .into_channel();
        c.require_prepared().unwrap();
        c.reserve_execution(7).unwrap();
        c.receive(json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}}).to_string().as_bytes()).unwrap();
        let proof = c.take_prepared().unwrap();
        c.finish_provider_write(proof).unwrap();
        c.receive(json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{"turn":{"id":"turn:1","status":"inProgress"}}}}}).to_string().as_bytes()).unwrap();
        c
    }
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    fn begin(c: &mut BrokerChannel) {
        c.steering(ID.into(), "turn:1", json!({"id":ID,"method":"turn/steer"}))
            .unwrap();
    }
    fn prepared() -> Vec<u8> {
        json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":3}}).to_string().into_bytes()
    }
    fn ack(turn: &str) -> Vec<u8> {
        json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":{"id":ID,"result":{"turnId":turn}}}}).to_string().into_bytes()
    }
    fn delta(turn: &str) -> Vec<u8> {
        json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"item/agentMessage/delta","params":{"turnId":turn,"threadId":"native:1","delta":"bounded"}}}}).to_string().into_bytes()
    }
    #[test]
    fn active_progress_during_preparation_does_not_authorize_ack_or_write() {
        let mut c = running();
        begin(&mut c);
        assert!(c.receive(&delta("turn:1")).unwrap().is_some());
        assert!(c.take_prepared().is_err());
        c.receive(&prepared()).unwrap();
        let proof = c.take_prepared().unwrap();
        assert!(c.receive(&delta("turn:1")).unwrap().is_some());
        c.finish_provider_write(proof).unwrap();
        assert!(c.receive(&ack("turn:1")).unwrap().is_none());
        assert_eq!(c.take_steering_ack(), Some(true));
        assert!(c.steering(ID.into(), "turn:1", json!({"id":ID})).is_err());
    }
    #[test]
    fn premature_ack_foreign_turn_and_duplicate_prepared_poison() {
        let mut c = running();
        begin(&mut c);
        assert!(c.receive(&ack("turn:1")).is_err());
        let mut c = running();
        begin(&mut c);
        assert!(c.receive(&delta("foreign")).is_err());
        let mut c = running();
        begin(&mut c);
        c.receive(&prepared()).unwrap();
        assert!(c.receive(&prepared()).is_err());
        let mut c = running();
        begin(&mut c);
        c.receive(&prepared()).unwrap();
        let p = c.take_prepared().unwrap();
        c.finish_provider_write(p).unwrap();
        assert!(c.receive(&ack("foreign")).is_err());
    }
}
