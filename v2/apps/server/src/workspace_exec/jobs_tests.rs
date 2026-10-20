use super::*;

fn scratch() -> PathBuf {
    let home = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
    let root = home.join(format!("jobs-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    root
}

fn record(id: Uuid, state: JobState) -> Record {
    Record {
        id,
        state,
        command_sha256: "0".repeat(64),
        started_at_ms: 1,
        finished_at_ms: None,
        exit_code: None,
        signal: None,
        output_bytes: 0,
        tail: String::new(),
    }
}

#[test]
fn restart_marks_unowned_running_records_lost_and_keeps_finished_ones() {
    let root = scratch();
    let directory = root.join("jobs");
    std::fs::create_dir(&directory).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (running, finished) = (Uuid::new_v4(), Uuid::new_v4());
    let mut done = record(finished, JobState::Exited);
    done.exit_code = Some(0);
    done.tail = "ok\n".into();
    for value in [record(running, JobState::Running), done] {
        std::fs::write(
            directory.join(format!("{}.json", value.id)),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    let jobs = Jobs::for_directory(&directory).unwrap();
    assert!(Arc::ptr_eq(
        &jobs,
        &Jobs::for_directory(&directory).unwrap()
    ));
    let lost = jobs.snapshot(running).unwrap();
    assert_eq!(lost.state, JobState::Lost);
    assert!(lost.finished_at_ms.is_some());
    let kept = jobs.snapshot(finished).unwrap();
    assert_eq!((kept.state, kept.exit_code), (JobState::Exited, Some(0)));
    assert!(jobs.snapshot(Uuid::new_v4()).is_none());
    assert!(
        !jobs.cancel(running),
        "a lost job has no live owner to signal"
    );
    assert_eq!(jobs.running(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn job_directory_must_be_private_and_records_are_closed() {
    let root = scratch();
    let open = root.join("open");
    std::fs::create_dir(&open).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Jobs::for_directory(&open).is_err());
    assert!(Jobs::for_directory(Path::new("relative-jobs")).is_err());
    let created = root.join("created");
    let jobs = Jobs::for_directory(&created).unwrap();
    assert_eq!(
        std::fs::metadata(&created).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let id = Uuid::new_v4();
    let mut value = serde_json::to_value(record(id, JobState::Exited)).unwrap();
    value["command"] = serde_json::json!("forged extra field");
    std::fs::write(
        created.join(format!("{id}.json")),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    assert!(jobs.snapshot(id).is_none());
    std::fs::remove_dir_all(root).unwrap();
}
