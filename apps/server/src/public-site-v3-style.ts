export const publicSiteV3Css = `
.v3-hero .hero-copy { max-width: 780px; }
.requirement-delivery { align-self: stretch; }
.requirement-quote { margin: 18px 0 0; padding: 22px; border: 1px solid #35443a; border-left: 4px solid var(--accent); background: #16231b; }
.requirement-quote small { color: #8e9b91; font: 700 9px ui-monospace, monospace; letter-spacing: .08em; }
.requirement-quote blockquote { margin: 12px 0 0; color: #fff; font-size: clamp(20px,2.3vw,30px); font-weight: 760; line-height: 1.18; letter-spacing: -.025em; }
.project-scenario-tabs { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 1px; margin: 1px 0 18px; background: #35443a; }
.project-scenario-tabs button { min-height: 50px; padding: 9px; border: 0; background: #121f17; color: #9eaaa0; font-size: 11px; font-weight: 760; cursor: pointer; }
.project-scenario-tabs button:hover, .project-scenario-tabs button.active { background: #2b392f; color: #fff; }
.delivery-trace { grid-template-columns: repeat(2,minmax(0,1fr)); }
.delivery-trace li { min-height: 122px; }
.delivery-trace li::after { display: none; }
.delivery-trace .trace-icon { font-size: 10px; }
.offer-section, .solution-index { gap: 46px; }
.offer-grid { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 1px; border: 1px solid var(--line); background: var(--line); }
.offer-card { display: flex; flex-direction: column; min-width: 0; min-height: 440px; padding: clamp(22px,2.5vw,34px); background: var(--panel); }
.offer-card > span { color: var(--accent); font: 760 11px ui-monospace, monospace; letter-spacing: .1em; }
.offer-card h3 { margin: 30px 0 18px; font-size: clamp(22px,2.3vw,32px); }
.offer-card blockquote { margin: 0 0 24px; color: var(--ink); font-size: 16px; font-weight: 720; line-height: 1.45; }
.offer-card p, .offer-card ul { color: var(--muted); font-size: 14px; line-height: 1.5; }
.offer-card ul { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.offer-card li::before { content: "—"; margin-right: 7px; color: var(--accent); }
.offer-card a { margin-top: auto; padding-top: 28px; font-weight: 800; text-decoration: none; }
.ugly-problem { display: grid; grid-template-columns: minmax(0,.82fr) minmax(0,1.18fr); gap: clamp(42px,7vw,100px); padding: clamp(78px,10vw,142px) clamp(20px,6vw,96px); border-bottom: 1px solid #35443a; background: var(--dark); color: #f4f0e7; }
.ugly-problem .section-lead { color: #aeb9b0; }
.ugly-problem .button { margin-top: 24px; }
.problem-quotes { display: grid; gap: 1px; align-self: start; background: #35443a; }
.problem-quotes blockquote { margin: 0; padding: 22px 25px; background: #121f17; color: #e4ebe5; font-size: clamp(17px,1.8vw,23px); font-weight: 730; line-height: 1.3; }
.example-projects { gap: 46px; background: #ebe6d8; }
.example-project-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }
.example-project { padding: clamp(26px,4vw,46px); border: 1px solid var(--line); background: var(--panel); }
.example-project blockquote { min-height: 75px; margin: 26px 0; font-size: clamp(22px,2.7vw,36px); font-weight: 800; line-height: 1.12; letter-spacing: -.035em; }
.example-project > strong { display: block; margin-bottom: 18px; color: var(--accent); }
.example-project ul { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px 18px; margin: 0; padding: 20px 0 0; border-top: 1px solid var(--line); color: var(--muted); list-style: none; }
.example-project li::before { content: "✓"; margin-right: 7px; color: #226942; }
.project-delivery { grid-template-columns: minmax(0,.72fr) minmax(0,1.28fr); }
.project-delivery .button { grid-column: 2; }
.solution-principle, .solution-outcomes, .solution-delivery { grid-template-columns: minmax(0,.76fr) minmax(0,1.24fr); }
.solution-hero blockquote { max-width: 880px; margin: 38px 0; padding: 22px 26px; border-left: 4px solid var(--accent); background: #ebe6d8; font-size: clamp(20px,2.5vw,32px); font-weight: 780; line-height: 1.25; }
.solution-outcomes ul { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1px; margin: 0; padding: 1px; background: var(--line); list-style: none; }
.solution-outcomes li { padding: 26px; background: var(--panel); font-size: 19px; font-weight: 760; }
.solution-proof { grid-template-columns: .9fr 1.1fr; }
.project-hero .qualification-strip { max-width: 850px; }
@media (max-width: 1200px) {
  .offer-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .offer-card { min-height: 400px; }
}
@media (max-width: 760px) {
  .project-scenario-tabs, .delivery-trace, .offer-grid, .example-project-grid, .example-project ul, .solution-outcomes ul { grid-template-columns: 1fr; }
  .ugly-problem, .project-delivery, .solution-principle, .solution-outcomes, .solution-delivery, .solution-proof { grid-template-columns: 1fr; }
  .project-delivery .button { grid-column: 1; }
  .offer-card { min-height: 0; }
  .example-project blockquote { min-height: 0; }
}
`;
