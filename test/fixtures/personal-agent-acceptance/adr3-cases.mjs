// Test inventory only, NOT a product record, event envelope or provider API.
// Keep adapters pending until the owning lane exposes its real public surface.
export const adr3Source = Object.freeze({
  commit: "3a5c8c37",
  path: "docs/adr/0003-opinionated-personal-agent.md",
  sections: [2, 3, 4, 5, 9, 10],
});

// Acceptance expectations, never arguments for a real provisioning API.
export const adr3ProvisioningExpectations = Object.freeze({
  projectKinds: ["shopping-list", "software"],
  defaultResources: ["github_repo", "jira_project", "oxrm_workspace", "whatsapp_conversation"],
  trigger: "project_creation",
  desktopInstancesCreated: 0,
  provisioners: "fake_only",
});
export const adr3PluginLayers = Object.freeze([
  "package", "connections", "capabilities", "global_or_selected_project_bindings", "resource_instances",
]);

export const adr3Cases = [
  {
    id: "AT-01", title: "Receipt while busy", lanes: ["ingress", "runtime", "ui"],
    ops: ["OP-05", "OP-17", "OP-22", "OP-25"],
    scenario: "Pause reasoning and execution independently behind fixture latches; submit three concurrent owner messages and one duplicate through fake web/iOS/WhatsApp ingress.",
    assertions: [
      "Before either latch opens, each unique input has durable acceptance, a distinct correlated event/cursor, and a visible deterministic receipt in the same main conversation.",
      "A duplicate has one logical input and one reasoning-inbox item; changed-body key reuse is visibly refused within its scope.",
      "Release in reverse order: no lost messages or cross-parent answers; record receipt, fast-response and reasoning p50/p95 separately, with received distinguished from completed.",
    ],
    gap: "No integrated durable dual-session ingress and receipt fixture entry point exists on the pinned base.",
    foundations: ["PA-R01"],
  },
  {
    id: "AT-02", title: "Strong reasoning", lanes: ["ingress", "runtime"],
    ops: ["OP-08", "OP-12", "OP-22", "OP-26"],
    scenario: "Submit a difficult synthetic request; make the fast session unavailable, then busy, while the capable reasoning-session stub remains available; finally remove that provider too.",
    assertions: [
      "Reasoning receives the durable event even when the fast session produces no output; a router-only response is not a full answer.",
      "The selected capable reasoning profile either returns cited fixture evidence or a bounded task/run with explicit pending state.",
      "Provider loss, quota and expired authentication are visible blockers with no silent local/cloud substitution or invented result.",
    ],
    gap: "Subscription-session dispatch and profile selection must be bound to the runtime lane, not the optional local adapter.",
    foundations: ["PA-R06"],
  },
  {
    id: "AT-03", title: "Real session architecture", lanes: ["runtime"],
    ops: ["OP-08", "OP-12", "OP-22", "OP-26"],
    scenario: "Resolve one global and one project conversation; start fast, reasoning and a supervised execution session; change the model/profile and recreate an expired native session.",
    assertions: [
      "Each scope has distinct persistent fast/reasoning native references and separately supervised execution, not one multiplexed native session.",
      "Changing provider/profile/native session preserves canonical conversation identity and transcript order without additional user-visible main chats.",
      "Selected provider/auth provenance is inspectable; offline fixture identifiers alone cannot certify real subscription authentication or reasoning quality.",
    ],
    gap: "Real-session orchestration is pending; supported subscription-backed runtime smoke evidence is a separate owner-authorized gate.",
    foundations: [],
  },
  {
    id: "AT-04", title: "Cross-project coordination", lanes: ["ingress", "runtime"],
    ops: ["OP-06", "OP-12", "OP-14", "OP-22", "OP-27", "OP-31"],
    scenario: "From global scope consult three authorized fixture projects concurrently; block one, return the others out of order, and include an unauthorized fourth project.",
    assertions: [
      "Every request/result is correlated to the global cause and its own project, with a truthful partial result and explicit blocker.",
      "Project main conversations still accept owner input while consultation is busy; no owner impersonation or implicit resource takeover occurs.",
      "Unauthorized project content is never read or included; delayed/duplicate results do not overwrite another project's answer.",
    ],
    gap: "Global-to-project asynchronous fan-out/fan-in and scope-bound consultation APIs are pending.",
    foundations: [],
  },
  {
    id: "AT-05", title: "Mid-run modification", lanes: ["ingress", "runtime"],
    ops: ["OP-05", "OP-12", "OP-14", "OP-22", "OP-25"],
    scenario: "Pause immediately before a fake external effect; concurrently deliver an authorized task correction, a duplicate correction and an untrusted worker instruction; replay after restart.",
    assertions: [
      "Authorized correction updates or supersedes the bound task in causal order; all accepted messages and the old/new intent remain inspectable.",
      "The obsolete action cannot dispatch under an old approval/args digest; uncertain already-dispatched effects reconcile or await owner action, never retry blindly.",
      "One logical external effect/notification occurs across correction and restart; worker/web text cannot expand the scope or become owner authority.",
    ],
    gap: "Task-bound steering/supersession must be integrated with existing effects and approval consumption.",
    foundations: ["PA-R01", "PA-R02", "PA-R03", "PA-R04", "PA-R05"],
  },
  {
    id: "AT-06", title: "Hard stop", lanes: ["ingress", "runtime", "ui"],
    ops: ["OP-13", "OP-14", "OP-20", "OP-22", "OP-32"],
    scenario: "Keep both model latches closed; issue stop/deployment hold immediately before dispatch, during an in-flight effect and after commit; repeat concurrently and after restart.",
    assertions: [
      "The deterministic control plane persists the target-specific hold before acknowledging it, without needing a model reply or native steering.",
      "No new target effect starts after the hold; another project's permitted action is unaffected, and stale approval/fencing identities cannot bypass it.",
      "The UI distinguishes stopped-before-dispatch from already-dispatched/too-late or unknown; never promise reversal of a completed effect.",
    ],
    gap: "Durable control holds and dispatch-time task gates are pending; sending stop text to a model is insufficient.",
    foundations: ["PA-R03", "PA-R05"],
  },
  {
    id: "AT-07", title: "Resource reuse and isolation", lanes: ["ingress", "runtime"],
    ops: ["OP-03", "OP-14", "OP-16", "OP-22", "OP-27"],
    scenario: "Fast/deep/worker sessions resolve project A's bindings; project B requests A's private resource; expire a desktop heartbeat and test a stale holder after safe reacquisition.",
    assertions: [
      "All authorized project A sessions resolve the same canonical resource binding rather than per-session copies; B cannot read or use A's private resource.",
      "A deliberately shared desktop is leased/released/reused with current fencing; stale leases block before any browser/tool effect and produce a visible remedy.",
      "Budget/concurrency limits are scoped per owner/project; no implicit grant from sharing and no root-isolation claim.",
    ],
    gap: "Project binding resolution must be exercised through session/control APIs in addition to the existing lease primitive.",
    foundations: ["PA-R07"],
  },
  {
    id: "AT-07a", title: "Project provisioning", lanes: ["ingress", "ui"],
    ops: ["OP-03", "OP-21", "OP-22", "OP-27", "OP-30"],
    scenario: "Create shopping-list and software projects with default automatic provisioning through fake GitHub/Jira/OXRM/WhatsApp providers; retry concurrently; lose one credential and restart halfway through.",
    expectations: adr3ProvisioningExpectations,
    assertions: [
      "By default every new project of both kinds automatically provisions a GitHub repo, Jira project, OXRM workspace and project WhatsApp conversation; every completed step has a fake-provider receipt and canonical binding, never a placeholder.",
      "Retry/restart does not duplicate resources; missing/unsupported access leaves the exact step blocked with a remedy instead of claiming success.",
      "Project creation instantiates zero desktops; desktops are leased only on later demand. Fake provisioning preserves connection/participant intent, sends no real messages and changes no WhatsApp sender or route.",
    ],
    gap: "Durable default project provisioning with connection-aware retries is pending; no live provider work is authorized by these tests.",
    foundations: ["PA-R01", "PA-R03"],
  },
  {
    id: "AT-07b", title: "Plugin inheritance", lanes: ["ingress", "ui"],
    ops: ["OP-14", "OP-20", "OP-22", "OP-30"],
    scenario: "Install one synthetic plugin package with two account connections; resolve capabilities, global/selected-project bindings and resource instances; narrow one project's inherited default, then try escalation.",
    pluginLayers: adr3PluginLayers,
    assertions: [
      "All five layers remain distinct: package, connections (several accounts per plugin), capabilities, global/selected-project bindings and resource instances; a project selects only authorized accounts/capabilities.",
      "Global defaults are inherited and can only be narrowed per project; disabled use and escalation of that ceiling fail before an effect while another allowed project works.",
      "Revocation takes effect for pending work and across restart without silently changing the sending identity.",
    ],
    gap: "ADR 0003 plugin/connection inheritance is pending; acceptance must use the owning lane's contract rather than invent a registry.",
    foundations: ["PA-R04", "PA-R05"],
  },
  {
    id: "AT-07c", title: "Progressive onboarding", lanes: ["ingress", "ui"],
    ops: ["OP-18", "OP-21", "OP-22", "OP-30"],
    scenario: "Enter a fresh fixture install with only a supported reasoning provider; reach the assistant, then request a missing optional capability and complete its synthetic auth flow.",
    assertions: [
      "The assistant is usable without connecting every optional integration; authentication/health remediation is contextual and returns to the same conversation.",
      "Unavailable provider and partially provisioned projects are displayed truthfully; optional resources do not falsely appear ready.",
      "Setup/admin boundaries, tenant base paths, auth-intent callbacks and recovery routes remain reachable without redirect loops or credential exposure.",
    ],
    gap: "Progressive Integration Hub and native/web handoff require integrated UI/ingress fixtures.",
    foundations: [],
  },
  {
    id: "AT-08", title: "Worker choice and lineage", lanes: ["runtime"],
    ops: ["OP-12", "OP-15", "OP-19", "OP-22"],
    scenario: "Select reuse, fork and fresh workers for three fixture tasks; expire native sessions and inspect the durable decisions/outcomes after reopening storage.",
    assertions: [
      "Reuse retains the intended session; fork names its actual parent and pinned context snapshot; fresh has an explicit brief with no hidden inherited authority.",
      "Task/run/session identities, selection rationale, provider/profile and bounded resource grants remain inspectable after provider expiry.",
      "Unsupported native fork reports an explicit limitation or separately approved fresh strategy, never a fabricated fork/session ID.",
    ],
    gap: "Worker session strategy and lineage persistence must be bound to runtime lane APIs.",
    foundations: [],
  },
  {
    id: "AT-09", title: "Restart/recovery", lanes: ["ingress", "runtime"],
    ops: ["OP-05", "OP-12", "OP-13", "OP-22", "OP-25", "OP-26"],
    scenario: "Kill only a disposable Node fixture service after acceptance, before dispatch, after fake effect completion and before result delivery; restart its same temporary home.",
    assertions: [
      "Canonical input order, dual-session references/lineage, pending tasks, holds, leases and approvals reconcile without lost messages or duplicate effects.",
      "Seed a stalled heartbeat with injected time: exactly one evidenced blocker/notice appears, with bounded recovery rather than a wakeup/retry storm.",
      "Return the correlated verified result or explicit blocker; expired provider sessions and unknown effects never become invented success.",
    ],
    gap: "Whole-service dual-session/task/control recovery is pending; Agent Job process recovery alone is foundation evidence.",
    foundations: ["PA-R02", "PA-R03", "PA-R05", "PA-R10", "PA-R11"],
  },
  {
    id: "AT-10", title: "Trust gates", lanes: ["ingress", "runtime", "ui"],
    ops: ["OP-04", "OP-06", "OP-07", "OP-14", "OP-22"],
    scenario: "Worker/web text claims owner authority, requests a send/approval/memory save and says DONE; provide absent, changed, failed, unknown and denied verification evidence, then a valid artifact.",
    assertions: [
      "Untrusted text cannot certify completion, grant permissions, approve an effect or consent to durable memory; trusted source attribution survives restart.",
      "Only verified acceptance evidence yields task success; missing/stale/contradictory evidence yields a cited blocker/failure, regardless of model prose.",
      "Memory remains opt-in, scoped and forgettable; approvals bind exact action/target/args/expiry and one-time consumption; credential-shaped canaries do not enter logs.",
    ],
    gap: "Task evidence projection and end-to-end owner control wiring are pending even though memory/effect primitives exist.",
    foundations: ["PA-R04", "PA-R05", "PA-R09", "PA-G01", "PA-G02", "PA-G03"],
  },
  {
    id: "AT-11", title: "Native navigation", lanes: ["ui"],
    ops: ["OP-18", "OP-19", "OP-20", "OP-22", "OP-28"],
    scenario: "On a synthetic iOS fixture navigate global assistant -> project main -> task/run/resource/approval -> back; background/reconnect the app and switch project scopes.",
    assertions: [
      "One canonical main conversation per scope retains draft, ordered messages and continuation context across navigation/reconnect.",
      "Runs, resources, evidence and owner actions are reachable with accessible labels/focus, loading/error/empty states and redacted notifications.",
      "No other project's data or tokens leak into cached views; web-only DOM or fake session labels cannot satisfy native navigation acceptance.",
    ],
    gap: "Native navigation and mobile security/storage evidence require the UI lane's fixture target; no device release is authorized here.",
    foundations: [],
  },
  {
    id: "AT-12", title: "Compatibility", lanes: ["ingress", "runtime", "ui"],
    ops: ["OP-02", "OP-17", "OP-24", "OP-22"],
    scenario: "Run the same sanitized legacy home with the feature unset, 0 and false; compare web/thread/WhatsApp/password-handoff/Agent Job flows before and after a flag-on/flag-off cycle.",
    assertions: [
      "Existing routes, bindings, senders, paused timers, auth/approval policy and password blindness remain unchanged; no Personal Agent provider/session is launched.",
      "Off-first creates no Personal Agent tables; off-after-on preserves additive rows without reading/mutating them; migration reruns and backup restore preserve legacy evidence.",
      "No implicit deploy/merge, paid resource, outbound message or channel reroute occurs; absent runtime and legacy deep links retain recovery paths.",
    ],
    gap: "Whole-application/channel differential fixture coverage is pending; primitive flag-off tests are not full compatibility acceptance.",
    foundations: ["PA-R08", "PA-R10", "PA-R11"],
  },
];
