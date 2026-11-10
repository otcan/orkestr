//! Which check fenced a metadata fence stage: closed, value-free codes only.
//!
//! A fence stage reports `fenced` for many different checks. The check that
//! refuses records its code on this thread; the stage diagnostics take it
//! with the stage outcome. The innermost (first recorded) code wins. A code
//! is only ever read for a stage that itself returned `Fenced`, and every
//! fence starts by discarding a code a previous, unrelated operation left.
use super::*;
use std::cell::Cell;

thread_local! {
    static REASON: Cell<Option<&'static str>> = const { Cell::new(None) };
}

/// `Fenced`, remembering `reason` unless an inner check already gave one.
pub(crate) fn fenced(reason: &'static str) -> RuntimeStoreError {
    REASON.with(|slot| {
        if slot.get().is_none() {
            slot.set(Some(reason));
        }
    });
    RuntimeStoreError::Fenced
}

/// Names the check behind a `Fenced` result that has no code yet.
pub(crate) fn because<T>(result: Result<T>, reason: &'static str) -> Result<T> {
    match result {
        Err(RuntimeStoreError::Fenced) => Err(fenced(reason)),
        other => other,
    }
}

/// The recorded code, cleared.
pub(crate) fn take() -> Option<&'static str> {
    REASON.with(Cell::take)
}
