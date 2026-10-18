//! A payload ID is immutable: once removed, delayed reads cannot restore its text.
#[derive(Clone, Default)]
pub struct Output {
    pub text: Option<String>,
    removed: bool,
}
impl Output {
    pub fn observed(&mut self, text: Option<String>) {
        if text.is_none() {
            self.removed = true;
        }
        self.text = if self.removed { None } else { text };
    }
    pub fn unavailable(&mut self) {
        self.text = None;
    }
    pub fn removed(&self) -> bool {
        self.removed
    }
}
