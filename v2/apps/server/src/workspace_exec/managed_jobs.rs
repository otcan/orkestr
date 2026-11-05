//! Job records reuse the existing profile-scoped registry. Physical custody
//! belongs to the original Root anchor, never a reconstructed Core Child PID.
use super::*;

impl Jobs {
    pub(in crate::workspace_exec) fn attach_managed(
        self: &Arc<Self>,
        id: Uuid,
        command: &str,
        maximum: usize,
        output_limit: usize,
        wait: impl FnOnce(
                &WorkerCancellation,
                &mut dyn FnMut(&[u8]),
            ) -> Result<(Option<i32>, Option<i32>), WorkerSandboxError>
            + Send
            + 'static,
    ) -> Result<Started, &'static str> {
        if self.running() >= maximum {
            return Err("managed workspace job capacity changed");
        }
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
        self.persist(
            &*job
                .record
                .lock()
                .map_err(|_| "managed workspace job state")?,
        );
        let mut live = self.live.lock().map_err(|_| "managed workspace registry")?;
        if live.contains_key(&id) {
            return Err("managed workspace duplicate job");
        }
        live.insert(id, job.clone());
        drop(live);
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
