//! Four fixed native profiles; a slot survives until Runtime reaps its child.
use crate::{beta_config::roles::RoleLaunch, window_runtime::context::Context};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct WindowWorkers {
    pub context: Arc<Context>,
    pool: Pool,
}

#[derive(Clone)]
struct Pool {
    launches: Arc<[RoleLaunch; 4]>,
    occupied: Arc<Mutex<[bool; 4]>>,
}

pub(super) struct Slot {
    pub launch: RoleLaunch,
    index: usize,
    occupied: Arc<Mutex<[bool; 4]>>,
}

impl WindowWorkers {
    pub(crate) fn new(context: Arc<Context>, launches: [RoleLaunch; 4]) -> Self {
        Self {
            context,
            pool: Pool::new(launches),
        }
    }

    pub(super) fn reserve(&self) -> Result<Slot, &'static str> {
        self.pool.reserve()
    }
}

impl Pool {
    fn new(launches: [RoleLaunch; 4]) -> Self {
        Self {
            launches: Arc::new(launches),
            occupied: Arc::new(Mutex::new([false; 4])),
        }
    }

    fn reserve(&self) -> Result<Slot, &'static str> {
        let mut occupied = self
            .occupied
            .lock()
            .map_err(|_| "Worker profile pool poisoned")?;
        let index = occupied
            .iter()
            .position(|used| !used)
            .ok_or("Worker profile pool exhausted")?;
        occupied[index] = true;
        Ok(Slot {
            launch: self.launches[index].clone(),
            index,
            occupied: self.occupied.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Pool {
        Pool::new(std::array::from_fn(|index| RoleLaunch {
            launcher: format!("/opt/example/worker-{index}").into(),
            launcher_sha256: "a".repeat(64),
            workspace: "/srv/example/workspace".into(),
        }))
    }

    #[test]
    fn retained_child_resource_holds_exact_slot_across_scheduler_drop() {
        let original = pool();
        let clone = original.clone();
        let mut resources: Vec<Box<dyn Send>> = Vec::new();
        for index in 0..4 {
            let slot = original.reserve().unwrap();
            assert_eq!(
                slot.launch.launcher,
                std::path::PathBuf::from(format!("/opt/example/worker-{index}"))
            );
            resources.push(Box::new(slot));
        }
        assert!(clone.reserve().is_err());
        drop(original);
        assert!(
            clone.reserve().is_err(),
            "scheduler loss cannot reuse an owned child's profile"
        );
        drop(resources.remove(1));
        let reused = clone.reserve().unwrap();
        assert_eq!(reused.index, 1);
        assert!(clone.reserve().is_err());
        drop(resources);
        drop(reused);
        assert_eq!(
            clone
                .occupied
                .lock()
                .unwrap()
                .iter()
                .filter(|used| **used)
                .count(),
            0
        );
    }

    #[test]
    fn poisoned_slot_inventory_refuses_reuse() {
        let pool = pool();
        let occupied = pool.occupied.clone();
        assert!(std::thread::spawn(move || {
            let _lock = occupied.lock().unwrap();
            panic!("synthetic interrupted slot owner");
        })
        .join()
        .is_err());
        assert!(pool.reserve().is_err());
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut occupied) = self.occupied.lock() {
            occupied[self.index] = false;
        }
    }
}
