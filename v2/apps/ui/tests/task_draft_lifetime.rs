use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, RunId};
use orkestr_v2_ui::{
    session_scope::SessionScope,
    task_draft_lifetime::{use_task_draft, TaskDrafts},
    worker_tasks::TaskDraft,
};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

const CONV: &str = "00000000-0000-4000-8000-000000000001";
fn conversation(n: u64) -> ConversationId {
    serde_json::from_str(&format!("\"00000000-0000-4000-8000-{n:012}\"")).unwrap()
}
fn parent(n: u64) -> RunId {
    serde_json::from_str(&format!("\"00000000-0000-4000-8000-{n:012}\"")).unwrap()
}
#[derive(Default)]
struct Driver {
    selection: Option<Signal<Option<(u64, u64)>>>,
    session: Option<Signal<SessionScope>>,
    cache: Option<Signal<TaskDrafts>>,
    current: Option<Signal<TaskDraft>>,
    mounts: usize,
    drops: usize,
}
impl PartialEq for Driver {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self, other)
    }
}
#[derive(Clone, Props)]
struct Props {
    driver: Rc<RefCell<Driver>>,
}
impl PartialEq for Props {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.driver, &other.driver)
    }
}
fn root(props: Props) -> Element {
    let mut cache = use_signal(|| TaskDrafts::new(dioxus::dioxus_core::current_scope_id()));
    use_context_provider(move || cache);
    let mut session = use_signal(SessionScope::default);
    use_hook(move || {
        session.write().activate(CONV, &mut BTreeMap::new());
        cache.write().activate(session.read().generation());
    });
    let selection = use_signal(|| Some((1u64, 10u64)));
    {
        let mut d = props.driver.borrow_mut();
        d.selection = Some(selection);
        d.session = Some(session);
        d.cache = Some(cache);
    }
    rsx! {if let Some((conv,run))=selection() { Leaf {key:"{conv}-{run}-{session.read().generation()}",driver:props.driver,conversation:conv,parent:run,session} }}
}
#[component]
fn Leaf(
    driver: Rc<RefCell<Driver>>,
    conversation: u64,
    parent: u64,
    session: Signal<SessionScope>,
) -> Element {
    let draft = use_task_draft(
        crate::conversation(conversation),
        crate::parent(parent),
        session,
    );
    let mounted = driver.clone();
    use_hook(move || {
        mounted.borrow_mut().mounts += 1;
    });
    let dropped = driver.clone();
    use_drop(move || {
        dropped.borrow_mut().drops += 1;
    });
    driver.borrow_mut().current = draft;
    rsx! {p {"Task form"}}
}
fn render(dom: &mut VirtualDom) {
    let _ = dom.render_immediate_to_vec();
}
#[test]
fn real_component_unmount_remount_retains_frozen_request_and_isolates_parent_and_conversation() {
    let driver = Rc::new(RefCell::new(Driver::default()));
    let mut dom = VirtualDom::new_with_props(
        root,
        Props {
            driver: driver.clone(),
        },
    );
    dom.rebuild_in_place();
    let mut original = driver.borrow().current.unwrap();
    dom.in_runtime(|| {
        original
            .write()
            .edit("original task".into(), "independent instructions".into());
        original.write().set_time_limit("300000").unwrap();
        original
            .write()
            .prepare(conversation(1), parent(10), 7, true, "frozen-key".into())
            .unwrap();
        original
            .write()
            .edit("edited draft".into(), "next instructions".into());
        original.write().set_time_limit("900000").unwrap();
    });
    let mut selection = driver.borrow().selection.unwrap();
    dom.in_runtime(|| selection.set(None));
    render(&mut dom);
    assert_eq!(driver.borrow().drops, 1);
    dom.in_runtime(|| selection.set(Some((1, 11))));
    render(&mut dom);
    let other = driver.borrow().current.unwrap();
    assert!(dom.in_runtime(|| other.read().title.is_empty()));
    dom.in_runtime(|| selection.set(Some((2, 10))));
    render(&mut dom);
    assert!(dom.in_runtime(|| driver.borrow().current.unwrap().read().title.is_empty()));
    dom.in_runtime(|| selection.set(Some((1, 10))));
    render(&mut dom);
    let mut restored = driver.borrow().current.unwrap();
    dom.in_runtime(|| {
        assert_eq!(restored.read().title, "edited draft");
        assert_eq!(restored.read().time_limit().budget_ms(), Some(900000));
        let retry = restored
            .write()
            .prepare(
                conversation(1),
                parent(10),
                999,
                false,
                "must-not-replace".into(),
            )
            .unwrap();
        assert_eq!(retry.request.execution_budget_ms, Some(300000));
        assert_eq!(retry.request.lifetime_ms, 30000);
        assert_eq!(retry.request.request_key, "frozen-key");
        assert_eq!(retry.request.expected_control_revision, 7);
        assert_eq!(retry.request.title, "original task");
        assert_eq!(retry.request.instructions, "independent instructions");
    });
    assert_eq!(driver.borrow().mounts, 4);
    assert_eq!(driver.borrow().drops, 3);
}
#[test]
fn logout_clears_pooled_drafts_and_session_generation_refuses_old_callback() {
    let driver = Rc::new(RefCell::new(Driver::default()));
    let mut dom = VirtualDom::new_with_props(
        root,
        Props {
            driver: driver.clone(),
        },
    );
    dom.rebuild_in_place();
    let mut original = driver.borrow().current.unwrap();
    let mut session = driver.borrow().session.unwrap();
    let mut cache = driver.borrow().cache.unwrap();
    let old = dom.in_runtime(|| session.read().generation());
    dom.in_runtime(|| {
        original
            .write()
            .edit("private task".into(), "private instructions".into());
        cache.write().clear_owner();
        session.write().invalidate();
    });
    assert!(dom.in_runtime(|| original.read().title.is_empty()));
    dom.in_runtime(|| {
        session
            .write()
            .activate("00000000-0000-4000-8000-000000000002", &mut BTreeMap::new());
        cache.write().activate(session.read().generation());
    });
    render(&mut dom);
    dom.in_runtime(|| {
        assert!(!session.read().is_current(old));
        if session.read().is_current(old) {
            original
                .write()
                .edit("late foreign write".into(), "forbidden".into());
        }
        assert!(driver
            .borrow()
            .current
            .unwrap()
            .read()
            .instructions
            .is_empty());
    });
    assert_eq!(driver.borrow().mounts, 2);
    assert_eq!(driver.borrow().drops, 1);
}
