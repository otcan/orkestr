import { waitlistCss } from "./public-waitlist.js";

export function renderCommercialSiteCss() {
  return `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171915; background: #f2efe6; --ink: #171915; --muted: #5f635a; --paper: #f2efe6; --panel: #fbf9f2; --accent: #b63718; --dark: #101a14; --line: rgba(23,25,21,.16); }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 88px; }
body { margin: 0; min-width: 0; min-height: 100vh; overflow-x: hidden; background: var(--paper); }
a { color: inherit; }
button, input, textarea, select { font: inherit; }
:focus-visible { outline: 3px solid #1769aa; outline-offset: 3px; }
.skip-link { position: fixed; left: 16px; top: -80px; z-index: 100; padding: 12px 16px; background: #fff; color: #000; }
.skip-link:focus { top: 12px; }
.topbar { position: sticky; top: 0; z-index: 30; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: clamp(18px,3vw,42px); min-height: 72px; padding: 12px clamp(18px,4vw,64px); border-bottom: 1px solid var(--line); background: rgba(242,239,230,.94); backdrop-filter: blur(14px); }
.wordmark { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font-size: 18px; font-weight: 850; text-decoration: none; letter-spacing: -.02em; }
.wordmark span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--ink); color: var(--paper); font: 800 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
.desktop-nav { display: flex; justify-content: center; align-items: center; gap: clamp(14px,2.2vw,30px); }
.desktop-nav a, .text-action { color: #4e524a; font-size: 14px; font-weight: 720; text-decoration: none; }
.desktop-nav a:hover, .desktop-nav a[aria-current="page"], .text-action:hover { color: var(--ink); }
.header-actions { display: flex; align-items: center; gap: 16px; }
.mobile-menu { display: none; }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 20px; border: 1px solid var(--ink); border-radius: 3px; background: var(--ink); color: #fff; font-weight: 790; text-decoration: none; cursor: pointer; transition: transform .18s ease, background .18s ease; }
.button:hover { transform: translateY(-1px); background: #2b2e28; }
.button-small { min-height: 40px; padding: 0 15px; font-size: 14px; }
.button-ghost { background: transparent; color: var(--ink); }
.button-light { border-color: #fff; background: #fff; color: var(--dark); }
.button-outline { background: transparent; color: var(--ink); }
.button:disabled { cursor: wait; opacity: .62; transform: none; }
.hero { min-height: min(820px, calc(100vh - 72px)); }
.commercial-hero { display: grid; grid-template-columns: minmax(0, .88fr) minmax(500px, 1.12fr); gap: clamp(34px,5vw,84px); align-items: center; padding: clamp(64px,8vw,112px) clamp(20px,5vw,80px); border-bottom: 1px solid var(--line); }
.hero-copy { max-width: 690px; }
.eyebrow, .section-index, .proof-label, .console-kicker { margin: 0 0 16px; color: var(--accent); font: 760 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
h1, h2, h3, p { overflow-wrap: anywhere; }
h1 { margin: 0; max-width: 980px; font-size: clamp(52px,7vw,102px); line-height: .95; letter-spacing: -.065em; }
h1 em { color: var(--accent); font-family: Georgia, "Times New Roman", serif; font-weight: 400; }
h2 { margin: 0; font-size: clamp(36px,5vw,68px); line-height: 1; letter-spacing: -.05em; }
h3 { margin: 0; font-size: 22px; line-height: 1.15; letter-spacing: -.025em; }
.lead, .section-lead { margin: 24px 0 0; color: #4f544b; font-size: clamp(20px,2.3vw,29px); line-height: 1.36; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.microcopy, .disclaimer, .diagram-note, .legal-note { color: var(--muted); font-size: 13px; line-height: 1.55; }
.microcopy { margin: 16px 0 0; }
.coordination { min-width: 0; margin: 0; padding: clamp(20px,3vw,34px); border: 1px solid #29362e; border-radius: 8px; background: var(--dark); color: #f5f1e8; box-shadow: 0 28px 70px rgba(16,26,20,.2); }
.coordination figcaption { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 24px; color: #c8d0c9; font-size: 13px; }
.coordination figcaption span { color: #f47b54; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.coordination-grid { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr; align-items: stretch; gap: 8px; }
.system-node { min-width: 0; padding: 18px 14px; border: 1px solid #35443a; border-radius: 5px; background: #16231b; }
.system-node small, .system-node strong, .system-node span { display: block; }
.system-node small { margin-bottom: 24px; color: #97a39a; font: 700 9px ui-monospace, monospace; letter-spacing: .08em; }
.system-node strong { font-size: 16px; }
.system-node span { margin-top: 7px; color: #aeb9b0; font-size: 12px; line-height: 1.35; }
.system-node.active { border-color: #f47b54; }
.system-node.approval { border-color: #e7bd55; background: #292716; }
.flow-arrow { display: grid; place-items: center; color: #77827a; }
.diagram-note { margin: 20px 0 0; color: #aeb9b0; }
.trust-strip { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); margin: 0; padding: 0 clamp(20px,5vw,80px); border-bottom: 1px solid var(--line); background: var(--panel); list-style: none; }
.trust-strip li { padding: 20px 14px; border-right: 1px solid var(--line); color: #3f443c; font-size: 13px; font-weight: 780; text-align: center; }
.trust-strip li:first-child { border-left: 1px solid var(--line); }
.trust-strip li::before { content: "✓"; margin-right: 8px; color: #226942; }
.section { display: grid; gap: clamp(32px,5vw,76px); padding: clamp(72px,9vw,128px) clamp(20px,6vw,96px); border-bottom: 1px solid var(--line); }
.statement { grid-template-columns: .35fr 1fr; }
.statement .definition-grid { grid-column: 2; }
.definition-grid, .detail-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); }
.definition-grid div, .detail-grid article { padding: clamp(24px,3vw,40px); background: var(--panel); }
.definition-grid dt { margin-bottom: 12px; font-size: 23px; font-weight: 800; }
.definition-grid dd, .detail-grid p { margin: 0; color: var(--muted); line-height: 1.55; }
.section-heading { max-width: 950px; }
.workflow-examples { background: #ebe6d8; }
.cards { display: grid; gap: 16px; }
.cards.three { grid-template-columns: repeat(3,minmax(0,1fr)); }
.cards article { display: flex; flex-direction: column; min-height: 330px; padding: clamp(24px,3vw,38px); border: 1px solid var(--line); background: var(--panel); }
.cards article > span, .detail-grid article > span { margin-bottom: 48px; color: var(--accent); font: 750 11px ui-monospace, monospace; letter-spacing: .08em; }
.cards article p { margin: 18px 0; color: var(--muted); line-height: 1.55; }
.cards article a { margin-top: auto; font-weight: 780; text-decoration: none; }
.proof-section { padding: clamp(72px,9vw,128px) clamp(20px,5vw,80px); background: var(--dark); color: #f5f1e8; }
.section-heading.inverse p:not(.section-index) { color: #aeb9b0; font-size: 18px; line-height: 1.5; }
.console-proof { margin: 48px 0 0; border: 1px solid #35443a; background: #121f17; }
.console-proof > figcaption { display: grid; gap: 7px; padding: 22px 26px; border-bottom: 1px solid #35443a; }
.console-proof > figcaption strong { font-size: 20px; }
.console-proof > figcaption small { color: #9ea9a1; }
.console-grid { display: grid; grid-template-columns: 220px minmax(0,1fr) 250px; min-width: 0; }
.console-sidebar, .console-main, .console-context { min-width: 0; padding: 24px; }
.console-sidebar, .console-main { border-right: 1px solid #35443a; }
.queue-item { display: grid; gap: 6px; padding: 14px; border-left: 2px solid transparent; color: #8e9b91; }
.queue-item span { font: 11px ui-monospace, monospace; }
.queue-item.selected { border-color: #f47b54; background: #1b2a20; color: #fff; }
.console-header { display: flex; justify-content: space-between; gap: 20px; padding-bottom: 22px; border-bottom: 1px solid #35443a; }
.console-header p { margin: 0 0 6px; color: #9eaaa0; }
.status { height: fit-content; padding: 7px 9px; border: 1px solid #e7bd55; border-radius: 999px; color: #f2d689; font: 700 11px ui-monospace, monospace; white-space: nowrap; }
.timeline { display: grid; gap: 0; margin: 22px 0 0; padding: 0; list-style: none; }
.timeline li { display: grid; grid-template-columns: 60px 1fr; gap: 14px; min-width: 0; padding: 0 0 24px; color: #7e8a81; }
.timeline li > span { font: 11px ui-monospace, monospace; }
.timeline li div { position: relative; padding-left: 18px; border-left: 1px solid #435047; }
.timeline li div::before { content: ""; position: absolute; left: -5px; top: 2px; width: 9px; height: 9px; border-radius: 50%; background: #435047; }
.timeline li.complete, .timeline li.current { color: #edf2ed; }
.timeline li.complete div::before { background: #67b47f; }
.timeline li.current div::before { background: #e7bd55; box-shadow: 0 0 0 4px rgba(231,189,85,.12); }
.timeline p { margin: 5px 0 0; color: #98a39b; font-size: 13px; line-height: 1.45; }
.proof-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; }
.proof-actions button { padding: 7px 10px; border: 1px solid #4b5a50; background: transparent; color: #abb5ae; }
.proof-actions small { align-self: center; color: #7e8a81; }
.console-context ul { display: grid; gap: 10px; margin: 0 0 32px; padding: 0; list-style: none; }
.console-context li { display: flex; justify-content: space-between; gap: 10px; color: #d7ddd8; font-size: 13px; }
.console-context li span { color: #89968c; }
.walkthrough { display: grid; grid-template-columns: repeat(4,1fr); margin: 0; padding: 0; border-top: 1px solid #35443a; list-style: none; }
.walkthrough li { padding: 22px; border-right: 1px solid #35443a; }
.walkthrough span { display: block; margin-bottom: 20px; color: #f47b54; font: 11px ui-monospace, monospace; }
.walkthrough p { margin: 7px 0 0; color: #98a39b; font-size: 13px; line-height: 1.45; }
.implementation { grid-template-columns: .7fr 1.3fr; }
.phase-list { margin: 0; padding: 0; list-style: none; }
.phase-list li { display: grid; grid-template-columns: 70px 1fr; gap: 16px; padding: 24px 0; border-top: 1px solid var(--line); }
.phase-list li > span { color: var(--accent); font: 12px ui-monospace, monospace; }
.phase-list p { margin: 8px 0 0; color: var(--muted); line-height: 1.5; }
.security-callout { grid-template-columns: 1.05fr .95fr; background: #d9dfd1; }
.security-callout .text-link { margin-top: 28px; }
.plain-checks { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.plain-checks li { display: grid; gap: 5px; padding: 18px 0; border-bottom: 1px solid var(--line); }
.plain-checks li:first-child { border-top: 1px solid var(--line); }
.plain-checks li strong::before { content: "✓"; margin-right: 9px; color: #226942; }
.plain-checks li span { padding-left: 25px; color: var(--muted); line-height: 1.5; }
.text-link { width: fit-content; font-weight: 800; text-decoration: none; }
.credibility { grid-template-columns: .75fr 1.25fr; }
.evidence-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
.evidence-grid article { display: flex; flex-direction: column; min-width: 0; padding: 28px; border: 1px solid var(--line); background: var(--panel); }
.evidence-grid p { color: var(--muted); line-height: 1.5; }
.evidence-grid a { margin-top: auto; font-weight: 780; text-decoration: none; }
.faq { grid-template-columns: .65fr 1.35fr; background: #ebe6d8; }
.faq-list details { border-top: 1px solid var(--line); }
.faq-list details:last-child { border-bottom: 1px solid var(--line); }
.faq-list summary { padding: 22px 34px 22px 0; cursor: pointer; font-size: 20px; font-weight: 800; }
.faq-list p { margin: 0; padding: 0 34px 24px 0; color: var(--muted); font-size: 17px; line-height: 1.6; }
.final-cta { display: grid; justify-items: start; gap: 26px; padding: clamp(72px,10vw,140px) clamp(20px,8vw,120px); background: var(--accent); color: #fff; }
.final-cta h2 { max-width: 980px; }
.final-cta p { margin: 0; }
.final-cta.compact { grid-template-columns: 1fr auto; align-items: center; }
.page-hero { padding: clamp(72px,9vw,130px) clamp(20px,7vw,110px); border-bottom: 1px solid var(--line); }
.page-hero h1 { max-width: 1000px; }
.page-hero .lead { max-width: 900px; }
.detail-grid { grid-template-columns: repeat(2,1fr); }
.detail-grid article > span { display: block; margin-bottom: 34px; }
.detail-grid h2 { margin-bottom: 16px; font-size: clamp(28px,3vw,42px); }
.boundary-table, .responsibility, .architecture, .oss-boundary { grid-template-columns: .65fr 1.35fr; }
.boundary-table dl, .oss-boundary dl { margin: 0; }
.boundary-table dl div, .oss-boundary dl div { display: grid; grid-template-columns: .45fr 1fr; gap: 20px; padding: 22px 0; border-top: 1px solid var(--line); }
.boundary-table dt, .oss-boundary dt { font-weight: 800; }
.boundary-table dd, .oss-boundary dd { margin: 0; color: var(--muted); line-height: 1.5; }
.limitations { grid-template-columns: .75fr 1.25fr; background: #ebe6d8; }
.limitations ul, .prerequisites ol { display: grid; gap: 16px; margin: 0; color: var(--muted); font-size: 18px; line-height: 1.5; }
.security-flow { grid-template-columns: .7fr 1.3fr; align-items: center; }
.security-flow .coordination { align-self: center; }
.trust-section { gap: 38px; }
.trust-pillars { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }
.trust-pillars article { min-width: 0; padding: clamp(26px,3vw,40px); border: 1px solid var(--line); background: var(--panel); }
.trust-pillars article > span { display: block; margin-bottom: 46px; color: var(--accent); font: 750 11px ui-monospace, monospace; }
.trust-pillars p { color: var(--muted); line-height: 1.55; }
.access-comparison { grid-template-columns: .65fr 1.35fr; }
.access-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }
.access-grid article { padding: clamp(24px,3vw,36px); border: 1px solid var(--line); background: var(--panel); }
.access-grid .can { border-top: 4px solid #226942; }
.access-grid .cannot { border-top: 4px solid #8c3823; }
.access-grid ul { display: grid; gap: 13px; padding-left: 20px; color: var(--muted); line-height: 1.5; }
.security-evidence { grid-template-columns: .7fr 1.3fr; background: #d9dfd1; }
.evidence-panel .button { margin-top: 28px; }
.deployment-models { grid-template-columns: repeat(2,1fr); }
.deployment-models article { padding: clamp(28px,4vw,54px); border: 1px solid var(--line); background: var(--panel); }
.deployment-models h2 { margin-bottom: 20px; font-size: clamp(34px,4vw,52px); }
.deployment-models p:not(.eyebrow), .deployment-models li { color: var(--muted); line-height: 1.55; }
.plain-list { display: grid; gap: 12px; padding-left: 20px; }
.rollout, .responsibility { grid-template-columns: .65fr 1.35fr; }
.responsibility-cards { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.responsibility-cards article { min-width: 0; padding: 26px; border: 1px solid var(--line); background: var(--panel); }
.responsibility-cards p { color: var(--muted); line-height: 1.55; }
.responsibility-cards strong { color: var(--ink); }
.pairing-note { grid-template-columns: 1fr auto; align-items: end; background: #d9dfd1; }
.architecture-flow { display: grid; grid-template-columns: repeat(2,1fr); margin: 0; padding: 0; list-style: none; }
.architecture-flow li { padding: 28px; border: 1px solid var(--line); background: var(--panel); }
.architecture-flow span { display: block; margin-bottom: 30px; color: var(--accent); font: 11px ui-monospace, monospace; }
.architecture-flow p { color: var(--muted); line-height: 1.5; }
.code-section { display: grid; grid-template-columns: .7fr 1.3fr; gap: 40px; padding: clamp(72px,9vw,128px) clamp(20px,6vw,96px); background: var(--dark); color: #f4f0e7; }
.code-section p:not(.section-index) { color: #aeb9b0; line-height: 1.5; }
.code-section pre { min-width: 0; margin: 0; padding: 30px; overflow-x: auto; border: 1px solid #35443a; background: #0b120e; color: #d9e5da; line-height: 1.7; }
.code-section .actions { grid-column: 2; }
.code-section .button-outline { border-color: #87958a; color: #fff; }
.use-case-nav { position: sticky; top: 72px; z-index: 10; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 14px 20px; border-bottom: 1px solid var(--line); background: rgba(251,249,242,.96); backdrop-filter: blur(10px); }
.use-case-nav a { padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; font-weight: 760; text-decoration: none; }
.use-case-list { display: grid; gap: 1px; background: var(--line); }
.use-case { display: grid; grid-template-columns: .7fr 1.3fr; gap: clamp(32px,5vw,76px); padding: clamp(60px,8vw,108px) clamp(20px,7vw,110px); background: var(--paper); scroll-margin-top: 140px; }
.use-case:nth-child(even) { background: #ebe6d8; }
.use-case-heading h2 { font-size: clamp(36px,5vw,64px); }
.use-case-heading > p:not(.eyebrow) { color: var(--muted); font-size: 18px; line-height: 1.55; }
.process-flow { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.process-flow li { display: grid; grid-template-columns: 50px 1fr; gap: 14px; padding: 16px 0; border-top: 1px solid var(--line); }
.process-flow span { color: var(--accent); font: 750 11px ui-monospace, monospace; }
.process-flow p { margin: 0; line-height: 1.5; }
.decision-measure { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin: 28px 0 0; }
.decision-measure div { padding: 22px; border: 1px solid var(--line); background: var(--panel); }
.decision-measure dt { margin-bottom: 9px; font-weight: 800; }
.decision-measure dd { margin: 0; color: var(--muted); line-height: 1.5; }
.use-case .disclaimer { margin-top: 20px; }
.use-case-fit { grid-template-columns: .7fr 1.3fr; }
.booking-hero { background: #d9dfd1; }
.booking-section { display: grid; grid-template-columns: .9fr 1.1fr; gap: clamp(36px,7vw,96px); padding: clamp(60px,8vw,112px) clamp(20px,7vw,110px); }
.booking-expectations h2 { font-size: clamp(34px,4vw,56px); }
.booking-expectations .plain-checks { margin-top: 36px; }
.booking-card { align-self: start; padding: clamp(28px,4vw,50px); border: 1px solid var(--line); border-top: 5px solid var(--accent); background: var(--panel); box-shadow: 0 24px 60px rgba(16,26,20,.1); }
.booking-card h2 { margin-top: 22px; font-size: clamp(34px,4vw,52px); }
.booking-card > p { color: var(--muted); font-size: 18px; line-height: 1.55; }
.booking-duration { display: inline-flex; padding: 8px 11px; border: 1px solid var(--line); border-radius: 999px; font: 760 12px ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
.booking-button { width: 100%; margin-top: 18px; }
.booking-unavailable { margin-top: 24px; padding: 20px; border-left: 4px solid #a75a17; background: #fff6e9; }
.booking-unavailable p { color: var(--muted); line-height: 1.5; }
.booking-fallback { display: grid; gap: 8px; margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
.booking-contact { color: var(--muted); }
.booking-prep { grid-template-columns: .7fr 1.3fr; background: #ebe6d8; }
.booking-prep p { color: var(--muted); font-size: 18px; line-height: 1.6; }
.legal-page { min-height: 70vh; }
.legal-hero { padding: clamp(72px,9vw,130px) clamp(20px,7vw,110px) clamp(44px,6vw,78px); background: #d9dfd1; }
.legal-hero .lead { max-width: 900px; }
.legal-content { max-width: 980px; padding: clamp(40px,6vw,78px) clamp(20px,7vw,110px); }
.legal-content article { padding: 26px 0; border-bottom: 1px solid var(--line); }
.legal-content h2 { margin-bottom: 10px; font-size: 25px; letter-spacing: -.02em; }
.legal-content p, .legal-content li { margin: 0; color: var(--muted); font-size: 17px; line-height: 1.6; }
.legal-content p + p { margin-top: 14px; }
.legal-content ul { display: grid; gap: 10px; padding-left: 22px; }
.legal-content code { overflow-wrap: anywhere; color: var(--ink); }
.policy-meta { margin-top: 18px !important; font-size: 14px !important; font-weight: 750; }
${waitlistCss()}
.beta-page .waitlist-band { display: grid; grid-template-columns: .7fr 1.3fr; gap: clamp(36px,7vw,90px); padding: clamp(60px,8vw,112px) clamp(20px,7vw,110px); border-top: 1px solid var(--line); }
.footer { display: grid; grid-template-columns: 1.3fr repeat(3,1fr); gap: 34px; padding: 58px clamp(20px,5vw,80px) 34px; background: var(--dark); color: #edf2ed; }
.wordmark.inverse { color: #fff; }
.wordmark.inverse span { background: #fff; color: var(--dark); }
.footer-brand p { color: #9eaaa0; }
.footer nav { display: grid; align-content: start; gap: 10px; }
.footer nav strong { margin-bottom: 6px; font: 700 11px ui-monospace, monospace; letter-spacing: .08em; color: #7f8c82; }
.footer nav a { color: #d8dfd9; font-size: 14px; text-decoration: none; }
.footer-note { grid-column: 1/-1; margin: 18px 0 0; padding-top: 22px; border-top: 1px solid #35443a; color: #7f8c82; font-size: 12px; }
@media (max-width: 1050px) {
  .desktop-nav { display: none; }
  .topbar { grid-template-columns: auto 1fr auto; }
  .header-actions { justify-self: end; }
  .mobile-menu { display: block; position: relative; }
  .mobile-menu summary { cursor: pointer; font-weight: 750; }
  .mobile-menu nav { position: absolute; right: 0; top: 38px; display: grid; width: 210px; padding: 16px; border: 1px solid var(--line); background: var(--panel); box-shadow: 0 16px 36px rgba(0,0,0,.12); }
  .mobile-menu nav a { padding: 9px; text-decoration: none; }
  .commercial-hero { grid-template-columns: 1fr; }
  .console-grid { grid-template-columns: 180px minmax(0,1fr); }
  .console-context { grid-column: 1/-1; display: grid; grid-template-columns: repeat(2,1fr); gap: 24px; border-top: 1px solid #35443a; }
  .console-main { border-right: 0; }
}
@media (max-width: 760px) {
  html { scroll-padding-top: 68px; }
  .topbar { grid-template-columns: 1fr auto; min-height: 64px; padding: 10px 16px; }
  .header-actions .text-action { display: none; }
  .header-actions { grid-column: 2; grid-row: 1; }
  .header-actions .button { min-height: 38px; padding: 0 11px; font-size: 12px; }
  .mobile-menu { grid-column: 1/-1; }
  .mobile-menu summary { position: absolute; right: 0; top: -43px; margin-right: 0; transform: translateX(-138px); font-size: 13px; }
  .mobile-menu nav { top: 5px; }
  h1 { font-size: clamp(46px,15vw,72px); }
  h2 { font-size: clamp(34px,10vw,52px); }
  .commercial-hero { min-height: auto; padding-top: 58px; }
  .coordination { padding: 16px; }
  .coordination figcaption { display: grid; }
  .coordination-grid { grid-template-columns: 1fr; }
  .flow-arrow { height: 22px; transform: rotate(90deg); }
  .system-node small { margin-bottom: 9px; }
  .statement, .implementation, .security-callout, .credibility, .faq, .security-flow, .access-comparison, .security-evidence, .boundary-table, .rollout, .responsibility, .architecture, .oss-boundary, .limitations, .deployment-models, .pairing-note, .booking-section, .booking-prep, .beta-page .waitlist-band, .use-case, .use-case-fit, .code-section { grid-template-columns: 1fr; }
  .statement .definition-grid, .use-case .disclaimer, .code-section .actions { grid-column: 1; }
  .definition-grid, .detail-grid, .cards.three, .trust-pillars, .evidence-grid { grid-template-columns: 1fr; }
  .cards article { min-height: 260px; }
  .console-grid { grid-template-columns: 1fr; }
  .console-sidebar { border-right: 0; border-bottom: 1px solid #35443a; }
  .console-main { padding: 18px; }
  .console-header { display: grid; }
  .status { white-space: normal; }
  .console-context { grid-template-columns: 1fr; }
  .walkthrough { grid-template-columns: 1fr; }
  .walkthrough li { border-right: 0; border-bottom: 1px solid #35443a; }
  .architecture-flow, .access-grid, .responsibility-cards, .decision-measure { grid-template-columns: 1fr; }
  .final-cta.compact { grid-template-columns: 1fr; }
  .boundary-table dl div, .oss-boundary dl div { grid-template-columns: 1fr; }
  .use-case { gap: 24px; }
  .trust-strip { grid-template-columns: repeat(2,minmax(0,1fr)); padding: 0 16px; }
  .trust-strip li { border-bottom: 1px solid var(--line); }
  .trust-strip li:last-child { grid-column: 1/-1; }
  .use-case-nav { top: 64px; justify-content: flex-start; overflow-x: auto; flex-wrap: nowrap; }
  .use-case-nav a { flex: 0 0 auto; }
  .topbar { grid-template-columns: 1fr auto; }
  .header-actions { display: none; }
  .mobile-menu { grid-column: 2; grid-row: 1; justify-self: end; }
  .mobile-menu summary { position: static; margin: 0; transform: none; }
  .mobile-menu nav { top: calc(100% + 12px); }
  .footer { grid-template-columns: repeat(2,1fr); }
  .footer-brand, .footer-note { grid-column: 1/-1; }
}
@media (max-width: 430px) {
  .wordmark { font-size: 16px; }
  .actions .button { width: 100%; }
  .timeline li { grid-template-columns: 42px 1fr; gap: 7px; }
  .footer { grid-template-columns: 1fr; }
  .footer-brand, .footer-note { grid-column: 1; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
`;
}
