//! One native result per explicitly delegated offline tool. Correlation is data;
//! durable consumption and current execution fences supply the authority.
use super::*;
use crate::runtime::ledger::{hash, secret};
mod call;
mod consume;
mod fence;
mod output;
mod prepare;
mod types;
pub use types::*;

#[cfg(test)]
mod tests;
