//! Negative metadata cleanup only; a setup child never needs a synthetic run.
use super::{PreparingCodex, ReadyCodex};
use crate::containment::{metadata::RetiringMetadata, Error};

impl PreparingCodex {
    pub fn retire_setup(mut self) -> Result<RetiringMetadata, Error> {
        self.child
            .take()
            .ok_or(Error::AuthorityProtocol)?
            .retire_broker()
    }
}

impl ReadyCodex {
    pub fn retire_setup(self) -> Result<RetiringMetadata, Error> {
        self.child.retire_broker()
    }
}
