//! Session generations fence asynchronous UI writes; the authenticated global
//! conversation is a retention namespace, never an authorization credential.
use crate::Draft;
use std::collections::BTreeMap;
#[derive(Clone, Default)]
pub struct SessionScope {
    binding: Option<String>,
    active: bool,
    generation: u64,
}
impl SessionScope {
    fn advance(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("session generation exhausted");
    }
    /// Without a stable owner identifier, retain drafts only for the same
    /// authenticated global conversation. A changed binding clears them all.
    pub fn activate(&mut self, global: &str, drafts: &mut BTreeMap<String, Draft>) -> u64 {
        self.advance();
        if global.is_empty() || self.binding.as_deref() != Some(global) {
            drafts.clear();
        }
        self.binding = (!global.is_empty()).then(|| global.to_string());
        self.active = !global.is_empty();
        self.generation
    }
    pub fn invalidate(&mut self) {
        self.advance();
        self.active = false;
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// Stable owner retention namespace, available only during authentication.
    /// This global conversation ID grants no API authority.
    pub fn retention_namespace(&self) -> Option<&str> {
        if self.active {
            self.binding.as_deref()
        } else {
            None
        }
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.active && generation == self.generation
    }
}
