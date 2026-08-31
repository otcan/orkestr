export const publicSiteEvidenceCss = `
.v4-hero-visual { display: grid; align-items: end; min-width: 0; }
.v4-system-visual { position: relative; margin: 0; overflow: hidden; border: 1px solid #35443a; background: var(--dark); box-shadow: 20px 24px 0 #d9dfd1; }
.v4-system-visual img { display: block; width: 100%; height: auto; aspect-ratio: 1.72; object-fit: cover; }
.v4-system-visual figcaption { position: absolute; right: 14px; bottom: 14px; padding: 8px 10px; border: 1px solid rgba(255,255,255,.24); background: rgba(16,26,20,.82); color: #f4f0e7; font: 740 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; backdrop-filter: blur(8px); }
.v4-hero-visual .v4-brief-card { position: relative; z-index: 2; width: calc(100% - 48px); margin: -46px 24px 0; box-shadow: none; }
.real-example-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; margin-top: 48px; }
.real-example-card { display: grid; align-content: start; min-width: 0; padding: clamp(24px,2.8vw,38px); border: 1px solid var(--line); background: #fffefa; box-shadow: 0 18px 44px rgba(16,26,20,.06); }
.real-example-card h3 { font-size: clamp(25px,2.4vw,36px); }
.real-example-card blockquote { margin: 24px 0; color: #3f443c; font: 680 17px/1.45 Georgia, "Times New Roman", serif; }
.real-system-flow { display: grid; gap: 0; margin: 0 0 24px; padding: 0; border-top: 1px solid var(--line); list-style: none; }
.real-system-flow li { position: relative; padding: 11px 10px 11px 30px; border-bottom: 1px solid var(--line); color: var(--ink); font: 730 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
.real-system-flow li::before { content: "↓"; position: absolute; left: 8px; color: var(--accent); }
.example-hooks { display: grid; gap: 1px; margin: 0; border: 1px solid var(--line); background: var(--line); }
.example-hooks div { padding: 13px 14px; background: var(--panel); }
.example-hooks dt { color: var(--accent); font: 750 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
.example-hooks dd { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.real-example-note { max-width: 900px; margin: 18px 0 28px; color: var(--muted); font-size: 13px; line-height: 1.55; }
.solution-visual-section { grid-template-columns: minmax(280px,.6fr) minmax(0,1.4fr); align-items: start; background: #d9dfd1; }
.solution-visual-section .section-lead { font-size: 18px; }
.solution-map-visual { min-width: 0; margin: 0; padding: clamp(20px,3vw,32px); border: 1px solid #35443a; background: var(--dark); color: #f4f0e7; box-shadow: 0 28px 64px rgba(16,26,20,.16); }
.solution-map-image { display: block; width: 100%; height: auto; margin-bottom: 18px; border: 1px solid #35443a; aspect-ratio: 1.75; object-fit: cover; }
.solution-system-flow { display: grid; grid-template-columns: repeat(auto-fit,minmax(112px,1fr)); gap: 1px; margin: 0; padding: 1px; background: #35443a; list-style: none; }
.solution-system-flow li { position: relative; display: grid; align-content: space-between; gap: 28px; min-height: 132px; padding: 17px; background: #142119; }
.solution-system-flow li::after { content: "→"; position: absolute; z-index: 2; right: -9px; top: 50%; display: grid; place-items: center; width: 18px; height: 18px; background: #142119; color: #cf674d; transform: translateY(-50%); }
.solution-system-flow li:last-child::after { display: none; }
.solution-system-flow span { color: #cf674d; font: 750 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.solution-system-flow strong { font-size: 14px; line-height: 1.35; }
.solution-map-visual figcaption { margin-top: 18px; color: #9eaaa0; font-size: 12px; line-height: 1.5; }
.security-document-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.security-document-card { display: grid; gap: 20px; min-width: 0; padding: 24px; border: 1px solid var(--line); background: var(--panel); text-decoration: none; transition: transform .18s ease, border-color .18s ease; }
.security-document-card:hover { transform: translateY(-2px); border-color: var(--accent); }
.security-document-card code { color: var(--accent); font: 740 11px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.security-document-card strong { font-size: 20px; }
.security-document-card span { color: var(--muted); font-size: 14px; line-height: 1.5; }
@media (max-width: 1060px) {
  .real-example-grid { grid-template-columns: 1fr; }
  .real-example-card { grid-template-columns: minmax(220px,.7fr) minmax(0,1.3fr); gap: 0 30px; }
  .real-example-card header, .real-example-card blockquote { grid-column: 1; }
  .real-system-flow, .example-hooks { grid-column: 2; }
  .real-system-flow { grid-row: 1/3; }
}
@media (max-width: 760px) {
  .v4-hero-visual .v4-brief-card { width: calc(100% - 24px); margin: -24px 12px 0; }
  .real-example-card, .solution-visual-section { grid-template-columns: 1fr; }
  .real-example-card header, .real-example-card blockquote, .real-system-flow, .example-hooks { grid-column: 1; grid-row: auto; }
  .solution-system-flow { grid-template-columns: 1fr; }
  .solution-system-flow li { min-height: 0; }
  .solution-system-flow li::after { content: "↓"; right: auto; left: 25px; top: auto; bottom: -9px; transform: none; }
  .security-document-grid { grid-template-columns: 1fr; }
}
@media (max-width: 430px) {
  .v4-system-visual figcaption { position: static; border: 0; background: var(--dark); }
  .v4-hero-visual .v4-brief-card { width: 100%; margin: 0; }
}
`;
