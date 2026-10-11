export const publicSiteV4Css = `
.v4-section { padding: clamp(72px,9vw,128px) clamp(20px,6vw,96px); border-bottom: 1px solid var(--line); }
.v4-section-head { max-width: 900px; }
.v4-section-head > p:not(.section-index) { max-width: 760px; margin: 22px 0 0; color: var(--muted); font-size: 19px; line-height: 1.55; }
.v4-hero { display: grid; grid-template-columns: minmax(0,1.04fr) minmax(360px,.7fr); gap: clamp(44px,7vw,112px); align-items: center; min-height: calc(100vh - 72px); background: #f2efe6; }
.v4-hero-copy { max-width: 820px; }
.v4-hero h1 { max-width: 850px; font-size: clamp(55px,7.5vw,108px); }
.v4-hero .lead { max-width: 760px; }
.v4-trust { display: flex; flex-wrap: wrap; gap: 9px 26px; margin: 34px 0 0; padding: 22px 0 0; border-top: 1px solid var(--line); color: var(--muted); list-style: none; }
.v4-trust li { font-size: 13px; font-weight: 760; }
.v4-trust li::before { content: "✓"; margin-right: 8px; color: #226942; }
.v4-brief-card { align-self: center; border: 1px solid #35443a; background: var(--dark); color: #f3f0e8; box-shadow: 20px 24px 0 #d9dfd1; }
.v4-brief-head { display: grid; gap: 9px; padding: 26px; border-bottom: 1px solid #35443a; }
.v4-brief-head span, .v4-brief-card dt { color: #8f9d92; font: 740 10px ui-monospace, monospace; letter-spacing: .09em; }
.v4-brief-head strong { font-size: clamp(22px,2.5vw,32px); }
.v4-brief-card dl { margin: 0; }
.v4-brief-card dl div { display: grid; grid-template-columns: 82px 1fr; gap: 16px; padding: 22px 26px; border-bottom: 1px solid #35443a; }
.v4-brief-card dd { margin: 0; color: #d8e0da; line-height: 1.45; }
.v4-brief-card > p { margin: 0; padding: 18px 26px; color: #aeb9b0; font-size: 13px; }
.v4-brief-card > p span { margin-right: 8px; color: #55b777; }
.v4-services { background: #ebe6d8; }
.v4-service-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1px; margin-top: 52px; border: 1px solid var(--line); background: var(--line); }
.v4-service-card { display: flex; flex-direction: column; min-height: 390px; padding: clamp(26px,3.2vw,44px); background: var(--panel); }
.v4-service-card > span { color: var(--accent); font: 760 11px ui-monospace, monospace; }
.v4-service-card h3 { margin-top: 34px; font-size: clamp(26px,3vw,40px); }
.v4-service-card p { color: var(--muted); font-size: 17px; line-height: 1.55; }
.v4-service-card small { color: #73786f; line-height: 1.5; }
.v4-service-card a { margin-top: auto; padding-top: 28px; font-weight: 820; text-decoration: none; }
.v4-examples { background: var(--panel); }
.v4-example-list { display: grid; gap: 1px; margin: 48px 0 26px; background: var(--line); }
.v4-example-list article { display: grid; grid-template-columns: 130px minmax(260px,1.2fr) minmax(220px,.8fr); gap: 28px; align-items: center; padding: clamp(24px,3vw,38px); background: var(--panel); }
.v4-example-list article > span { color: var(--accent); font: 760 11px ui-monospace, monospace; letter-spacing: .08em; }
.v4-example-list blockquote { margin: 0; font-size: clamp(21px,2.4vw,32px); font-weight: 820; line-height: 1.2; letter-spacing: -.03em; }
.v4-example-list p { margin: 0; color: var(--muted); line-height: 1.55; }
.v4-process { display: grid; grid-template-columns: minmax(280px,.72fr) minmax(0,1.28fr); gap: clamp(46px,8vw,128px); background: #d9dfd1; }
.v4-process .v4-section-head h2 { overflow-wrap: normal; font-size: clamp(36px,4.2vw,62px); }
.v4-process-list { display: grid; margin: 0; padding: 0; border-top: 1px solid var(--line); list-style: none; }
.v4-process-list li { display: grid; grid-template-columns: 54px 1fr; gap: 22px; padding: 25px 0; border-bottom: 1px solid var(--line); }
.v4-process-list li > span { padding-top: 4px; color: var(--accent); font: 760 11px ui-monospace, monospace; }
.v4-process-list p { margin: 7px 0 0; color: var(--muted); line-height: 1.5; }
.v4-proof { display: grid; grid-template-columns: minmax(280px,.62fr) minmax(0,1.38fr); gap: clamp(42px,6vw,86px); align-items: start; border-color: #35443a; background: var(--dark); color: #f4f0e8; }
.v4-proof-copy { position: sticky; top: 108px; }
.v4-proof-copy > p:not(.section-index) { color: #acb7ae; font-size: 17px; line-height: 1.58; }
.v4-proof-copy ul { display: grid; gap: 10px; margin: 28px 0; padding: 22px 0; border-top: 1px solid #35443a; border-bottom: 1px solid #35443a; color: #d9e1db; list-style: none; }
.v4-proof-copy li::before { content: "—"; margin-right: 8px; color: #cf674d; }
.v4-proof .console-proof { margin: 0; }
.v4-proof .console-grid { grid-template-columns: minmax(0,1fr); }
.v4-proof .console-sidebar, .v4-proof .console-context { display: none; }
.v4-proof .console-main { border-right: 0; }
.v4-final { display: grid; justify-items: start; gap: 24px; border: 0; background: var(--accent); color: #fff; }
.v4-final h2 { max-width: 950px; }
.v4-final > p:not(.section-index) { max-width: 760px; margin: 0; font-size: 20px; line-height: 1.55; }

.project-booking-hero { display: grid; grid-template-columns: minmax(0,1fr) minmax(340px,.62fr); gap: clamp(48px,8vw,120px); align-items: center; min-height: min(740px,calc(100vh - 72px)); padding: clamp(70px,9vw,126px) clamp(20px,7vw,110px); border-bottom: 1px solid var(--line); background: #d9dfd1; }
.project-booking-copy { max-width: 830px; }
.project-booking-copy h1 { font-size: clamp(52px,7vw,96px); }
.project-booking-copy ul { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 32px 0 0; padding: 22px 0 0; border-top: 1px solid var(--line); color: var(--muted); list-style: none; }
.project-booking-copy li { font-size: 13px; font-weight: 750; }
.project-booking-copy li::before { content: "✓"; margin-right: 7px; color: #226942; }
.booking-panel { padding: clamp(30px,4vw,50px); background: var(--dark); color: #f5f2ea; box-shadow: 18px 20px 0 rgba(255,255,255,.5); }
.booking-panel > p:first-child { color: #cf674d; font: 760 11px ui-monospace, monospace; letter-spacing: .09em; }
.booking-panel h2 { margin-top: 26px; overflow-wrap: normal; font-size: clamp(33px,3vw,48px); }
.booking-panel h2 + p { color: #afbab1; font-size: 17px; line-height: 1.55; }
.booking-primary { width: 100%; margin-top: 20px; }
.booking-note { margin: 12px 0 24px; color: #87938a !important; font-size: 12px !important; text-align: center; }
.booking-secondary { display: block; padding-top: 22px; border-top: 1px solid #35443a; color: #e4ebe5; font-size: 14px; font-weight: 760; text-align: center; text-decoration: none; }
.quick-intake-section { display: grid; grid-template-columns: minmax(260px,.58fr) minmax(0,1.42fr); gap: clamp(48px,8vw,120px); align-items: start; padding: clamp(72px,9vw,126px) clamp(20px,7vw,110px); border-bottom: 1px solid var(--line); }
.quick-intake-copy { position: sticky; top: 108px; }
.quick-intake-copy > p:not(.section-index) { color: var(--muted); font-size: 17px; line-height: 1.55; }
.quick-intake-copy .legal-note { margin-top: 30px; padding: 18px; border-left: 4px solid #a75a17; background: #fff6e9; font-size: 14px !important; }
.quick-project-form { gap: 24px; }
.project-type-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.project-type-fieldset legend { margin-bottom: 14px; font-weight: 800; }
.project-type-fieldset legend span, .quick-outcome b, .quick-contact b { margin-right: 8px; color: var(--accent); font: 760 11px ui-monospace, monospace; }
.project-type-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
.workflow-form .project-type-options label { position: relative; display: block; cursor: pointer; }
.project-type-options input { position: absolute; width: 1px; min-height: 1px; opacity: 0; }
.project-type-options label > span { display: grid; gap: 5px; min-height: 108px; padding: 19px; border: 1px solid #9da095; background: #fffefa; }
.project-type-options label > span strong { font-size: 17px; }
.project-type-options label > span small { font-size: 12px; }
.project-type-options input:checked + span { border-color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); background: #fff4ed; }
.project-type-options input:focus-visible + span { outline: 3px solid #1769aa; outline-offset: 3px; }
.adaptive-context { padding: 17px; border-left: 3px solid #c3c8be; background: #f2efe6; }
.project-more-details { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.project-more-details summary { display: flex; justify-content: space-between; gap: 20px; padding: 20px 0; font-weight: 800; cursor: pointer; }
.project-more-details summary span { color: var(--muted); font: 700 11px ui-monospace, monospace; text-transform: uppercase; }
.project-more-fields { display: grid; gap: 18px; padding: 4px 0 26px; }
.project-expectations { padding: clamp(66px,8vw,104px) clamp(20px,7vw,110px); background: #ebe6d8; }
.project-expectations ol { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1px; margin: 34px 0 0; padding: 1px; background: var(--line); list-style: none; }
.project-expectations li { padding: clamp(24px,3vw,36px); background: var(--panel); }
.project-expectations li > span { color: var(--accent); font: 760 11px ui-monospace, monospace; }
.project-expectations p { margin: 20px 0 0; color: var(--muted); line-height: 1.5; }
.project-expectations strong { display: block; margin-bottom: 8px; color: var(--ink); font-size: 20px; }
@media (max-width: 960px) {
  .v4-hero, .v4-process, .v4-proof, .project-booking-hero, .quick-intake-section { grid-template-columns: 1fr; }
  .v4-hero { min-height: auto; }
  .v4-brief-card { max-width: 680px; }
  .v4-proof-copy, .quick-intake-copy { position: static; }
  .v4-service-grid { grid-template-columns: 1fr; }
  .v4-service-card { min-height: 0; }
  .v4-example-list article { grid-template-columns: 105px 1fr; }
  .v4-example-list article p { grid-column: 2; }
}
@media (max-width: 620px) {
  .v4-hero h1, .project-booking-copy h1 { font-size: clamp(46px,15vw,68px); }
  .v4-brief-card { box-shadow: 10px 12px 0 #d9dfd1; }
  .v4-brief-card dl div, .v4-example-list article { grid-template-columns: 1fr; }
  .v4-example-list article p { grid-column: 1; }
  .project-type-options, .field-grid.two, .project-expectations ol { grid-template-columns: 1fr; }
  .booking-panel { box-shadow: 10px 12px 0 rgba(255,255,255,.5); }
}
`;
