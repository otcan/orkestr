use super::*;
use crate::control_registry::ControlRegistry;
use orkestr_v2_store_sqlite::Store;

#[tokio::test]
async fn only_exact_increasing_scope_can_replace_a_retired_handle() {
    let owner = OwnerId(Uuid::new_v4());
    let conversation = ConversationId(Uuid::new_v4());
    let handles = Handles::new(owner.clone(), conversation.clone()).unwrap();
    let directory = std::env::temp_dir().join(format!("window-handles-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("core.sqlite3")).await.unwrap();
    let scope = || ExecutionScope {
        store: store.clone(),
        control: Some(ControlRegistry::new(owner.clone(), conversation.clone())),
        tasks: None,
    };
    let first = Generation {
        window: Uuid::new_v4(),
        number: 1,
    };
    let second = Generation {
        window: Uuid::new_v4(),
        number: 2,
    };
    assert!(handles.snapshot(&owner, &conversation).is_none());
    handles.install(first, scope()).unwrap();
    assert!(handles.snapshot(&owner, &conversation).is_some());
    assert!(handles
        .snapshot(&OwnerId(Uuid::new_v4()), &conversation)
        .is_none());
    assert!(handles
        .snapshot(&owner, &ConversationId(Uuid::new_v4()))
        .is_none());
    assert!(handles.install(second, scope()).is_err());
    assert!(handles.remove(second).is_err());
    assert!(handles.snapshot(&owner, &conversation).is_some());
    handles.remove(first).unwrap();
    assert!(handles.install(first, scope()).is_err());
    handles.install(second, scope()).unwrap();
    assert!(handles.remove(first).is_err());
    assert!(handles.snapshot(&owner, &conversation).is_some());
    handles.poison();
    assert!(handles.snapshot(&owner, &conversation).is_none());
    assert!(handles
        .install(
            Generation {
                window: Uuid::new_v4(),
                number: 3
            },
            scope()
        )
        .is_err());
    assert!(handles.remove(second).is_err());
    drop(handles);
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn foreign_control_or_missing_control_never_becomes_a_live_handle() {
    let owner = OwnerId(Uuid::new_v4());
    let conversation = ConversationId(Uuid::new_v4());
    let handles = Handles::new(owner.clone(), conversation.clone()).unwrap();
    let directory = std::env::temp_dir().join(format!("window-handles-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("core.sqlite3")).await.unwrap();
    let generation = Generation {
        window: Uuid::new_v4(),
        number: 1,
    };
    for control in [
        None,
        Some(ControlRegistry::new(
            OwnerId(Uuid::new_v4()),
            conversation.clone(),
        )),
    ] {
        assert!(handles
            .install(
                generation,
                ExecutionScope {
                    store: store.clone(),
                    control,
                    tasks: None
                }
            )
            .is_err());
    }
    assert!(handles.snapshot(&owner, &conversation).is_none());
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn companion_handles_are_scope_checked_and_retire_atomically() {
    use crate::worker_tasks::WorkerTaskAccess;
    let owner = OwnerId(Uuid::new_v4());
    let conversation = ConversationId(Uuid::new_v4());
    let handles = Handles::new(owner.clone(), conversation.clone()).unwrap();
    let directory = std::env::temp_dir().join(format!("window-role-handles-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("core.sqlite3")).await.unwrap();
    let scope = |scoped_owner: OwnerId, tasks| ExecutionScope {
        store: store.clone(),
        control: Some(ControlRegistry::new(scoped_owner, conversation.clone())),
        tasks,
    };
    let generation = Generation {
        window: Uuid::new_v4(),
        number: 1,
    };
    let tasks = WorkerTaskAccess::new(owner.clone(), conversation.clone());
    for fast in [
        scope(OwnerId(Uuid::new_v4()), None),
        scope(owner.clone(), Some(tasks.clone())),
    ] {
        assert!(handles
            .install_roles(
                generation,
                scope(owner.clone(), Some(tasks.clone())),
                Some(fast)
            )
            .is_err());
        assert!(handles.snapshot(&owner, &conversation).is_none());
        assert!(handles.fast_snapshot(&owner, &conversation).is_none());
    }
    handles
        .install_roles(
            generation,
            scope(owner.clone(), Some(tasks)),
            Some(scope(owner.clone(), None)),
        )
        .unwrap();
    assert!(handles
        .snapshot(&owner, &conversation)
        .unwrap()
        .tasks
        .is_some());
    assert!(handles
        .fast_snapshot(&owner, &conversation)
        .unwrap()
        .tasks
        .is_none());
    assert!(handles
        .fast_snapshot(&OwnerId(Uuid::new_v4()), &conversation)
        .is_none());
    assert!(handles
        .fast_snapshot(&owner, &ConversationId(Uuid::new_v4()))
        .is_none());
    assert!(handles
        .remove(Generation {
            window: Uuid::new_v4(),
            number: 1
        })
        .is_err());
    assert!(handles.fast_snapshot(&owner, &conversation).is_some());
    handles.remove(generation).unwrap();
    assert!(handles.snapshot(&owner, &conversation).is_none());
    assert!(handles.fast_snapshot(&owner, &conversation).is_none());
    drop(handles);
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
}
