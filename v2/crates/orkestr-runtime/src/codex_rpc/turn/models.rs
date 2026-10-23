//! Native model evidence; an unconfirmed per-turn override stays unreported.
use orkestr_v2_contracts::{ExecutionModelObservation, ExecutionModelSource};
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Models {
    current: Option<String>,
    answered: Option<String>,
    pending: VecDeque<ExecutionModelObservation>,
}

impl Models {
    pub(super) fn initialize(&mut self, model: Option<&str>) {
        self.current = model
            .filter(|m| orkestr_v2_contracts::valid_observed_model(m))
            .map(str::to_owned);
        if let Some(model) = &self.current {
            self.pending.push_back(ExecutionModelObservation {
                source: ExecutionModelSource::Resolved,
                model: model.clone(),
            });
        }
    }
    pub(super) fn reroute(&mut self, model: &str) -> Result<(), crate::ports::Blocker> {
        if !orkestr_v2_contracts::valid_observed_model(model) {
            return Err(crate::ports::Blocker::Protocol);
        }
        self.current = Some(model.to_owned());
        Ok(())
    }
    pub(super) fn answered(&mut self) {
        if self.current.is_none() || self.current == self.answered {
            return;
        }
        self.answered = self.current.clone();
        self.pending.push_back(ExecutionModelObservation {
            source: ExecutionModelSource::Answer,
            model: self.current.clone().unwrap(),
        });
    }
    pub(super) fn take(&mut self) -> Option<ExecutionModelObservation> {
        self.pending.pop_front()
    }
}
