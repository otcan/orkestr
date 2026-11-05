//! Job records reuse the existing profile-scoped registry. Physical custody
//! belongs to the original Root anchor, never a reconstructed Core Child PID.
use super::*;

/// Reserved before positive activation. Root separately owns durable physical
/// accounting; dropping this token releases only one inert process-local slot.
pub(in crate::workspace_exec) struct ManagedReservation {
    jobs: Arc<Jobs>,
    id: Uuid,
}
impl Drop for ManagedReservation {
    fn drop(&mut self) {
        if let Ok(_live) = self.jobs.live.lock() {
            if let Ok(mut reserved) = self.jobs.reservations.lock() {
                reserved.remove(&self.id);
            }
        }
    }
}

impl Jobs {
    pub(in crate::workspace_exec) fn reserve_managed(
        self: &Arc<Self>,
        id: Uuid,
        maximum: usize,
    ) -> Result<Option<ManagedReservation>, &'static str> {
        let live = self.live.lock().map_err(|_| "managed workspace registry")?;
        let mut reserved = self
            .reservations
            .lock()
            .map_err(|_| "managed workspace reservations")?;
        if live.contains_key(&id) || reserved.contains(&id) {
            return Err("managed workspace duplicate reservation");
        }
        if active_count(&live)?.saturating_add(reserved.len()) >= maximum {
            return Ok(None);
        }
        reserved.insert(id);
        Ok(Some(ManagedReservation {
            jobs: self.clone(),
            id,
        }))
    }

    pub(in crate::workspace_exec) fn attach_managed(
        self: &Arc<Self>,
        reservation: ManagedReservation,
        id: Uuid,
        command: &str,
        output_limit: usize,
        wait: impl FnOnce(
                &WorkerCancellation,
                &mut dyn FnMut(&[u8]),
            ) -> Result<(Option<i32>, Option<i32>), WorkerSandboxError>
            + Send
            + 'static,
    ) -> Result<Started, &'static str> {
        let job = Arc::new(Job {
            record: Mutex::new(Record {
                id,
                state: JobState::Running,
                command_sha256: {
                    use sha2::Digest;
                    format!("{:x}", sha2::Sha256::digest(command.as_bytes()))
                },
                started_at_ms: now_ms(),
                finished_at_ms: None,
                exit_code: None,
                signal: None,
                output_bytes: 0,
                tail: String::new(),
            }),
            output: Mutex::new(Capture::new(output_limit)),
            cancel: WorkerCancellation::default(),
        });
        let mut live = self.live.lock().map_err(|_| "managed workspace registry")?;
        let mut reserved = self
            .reservations
            .lock()
            .map_err(|_| "managed workspace reservations")?;
        if !Arc::ptr_eq(self, &reservation.jobs)
            || reservation.id != id
            || !reserved.contains(&id)
            || live.contains_key(&id)
        {
            return Err("managed workspace reservation scope");
        }
        self.persist(
            &*job
                .record
                .lock()
                .map_err(|_| "managed workspace job state")?,
        );
        live.insert(id, job.clone());
        reserved.remove(&id);
        drop(reserved);
        drop(live);
        drop(reservation);
        let jobs = self.clone();
        std::thread::Builder::new()
            .name("managed-workspace-job".into())
            .spawn(move || {
                let result = wait(&job.cancel, &mut |bytes| {
                    if let Ok(mut output) = job.output.lock() {
                        output.push(bytes);
                    }
                });
                jobs.finish(&job, result);
            })
            .map_err(|_| "managed workspace reaper unavailable")?;
        Ok(Started::Started(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Barrier};

    #[test]
    fn two_concurrent_preparations_max_one_have_exactly_one_reserved_slot() {
        let directory = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("managed-slots-{}", Uuid::new_v4()));
        let jobs = Jobs::for_directory(&directory).unwrap();
        let start = Arc::new(Barrier::new(3));
        let release = Arc::new(Barrier::new(3));
        let (send, receive) = mpsc::channel();
        let mut threads = vec![];
        for _ in 0..2 {
            let (jobs, start, release, send) =
                (jobs.clone(), start.clone(), release.clone(), send.clone());
            threads.push(std::thread::spawn(move || {
                start.wait();
                let slot = jobs.reserve_managed(Uuid::new_v4(), 1).unwrap();
                send.send(slot.is_some()).unwrap();
                release.wait();
                drop(slot);
            }));
        }
        start.wait();
        let winners = usize::from(receive.recv().unwrap()) + usize::from(receive.recv().unwrap());
        assert_eq!(winners, 1);
        assert!(jobs.reserve_managed(Uuid::new_v4(), 1).unwrap().is_none());
        release.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        let slot = jobs.reserve_managed(Uuid::new_v4(), 1).unwrap().unwrap();
        drop(slot);
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn attaching_transfers_reserved_quota_without_a_gap_or_a_second_capacity_check() {
        let directory = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("managed-attach-{}", Uuid::new_v4()));
        let jobs = Jobs::for_directory(&directory).unwrap();
        let id = Uuid::new_v4();
        let slot = jobs.reserve_managed(id, 1).unwrap().unwrap();
        let (finish, wait) = mpsc::channel();
        jobs.attach_managed(slot, id, "synthetic", 128, move |_, _| {
            wait.recv().unwrap();
            Ok((Some(0), None))
        })
        .unwrap();
        assert_eq!(jobs.running(), 1);
        assert!(jobs.reserve_managed(Uuid::new_v4(), 1).unwrap().is_none());
        finish.send(()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while jobs.running() != 0 {
            assert!(std::time::Instant::now() < until);
            std::thread::sleep(Duration::from_millis(1));
        }
        let slot = jobs.reserve_managed(Uuid::new_v4(), 1).unwrap().unwrap();
        drop(slot);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
