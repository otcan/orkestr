export const publicSiteHubCss = `
.footer { grid-template-columns: 1.35fr repeat(6,minmax(100px,.62fr)); }
.hub-hero { max-width: 1180px; padding: clamp(72px,10vw,140px) clamp(20px,6vw,96px) clamp(56px,7vw,96px); }
.hub-hero-compact { padding-bottom: clamp(36px,5vw,64px); }
.hub-hero .lead { max-width: 820px; }
.hub-section { display: grid; gap: clamp(24px,3vw,40px); padding: clamp(56px,7vw,104px) clamp(20px,6vw,96px); border-top: 1px solid var(--line); }
.hub-section-head { max-width: 860px; }
.hub-section-head p:not(.section-index) { margin: 18px 0 0; color: var(--muted); font-size: 18px; line-height: 1.55; }
.hub-entry-grid, .hub-catalog-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,250px),1fr)); gap: 16px; margin: 0; padding: 0; list-style: none; }
.hub-entry-card, .hub-catalog-card { display: grid; align-content: start; gap: 14px; min-width: 0; padding: clamp(22px,2.4vw,30px); border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.hub-entry-card p:not(.section-index), .hub-catalog-card p { margin: 0; color: var(--muted); font-size: 16px; line-height: 1.55; }
.hub-entry-card .section-index { margin: 0; }
.hub-entry-card .text-link { margin-top: 6px; }
.hub-catalog-card h3 a { text-decoration: none; }
.hub-catalog-card h3 a:hover { text-decoration: underline; }
.hub-catalog-card.is-pending { background: transparent; border-style: dashed; }
.hub-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.hub-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 0 10px; border: 1px solid currentColor; border-radius: 999px; font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
.hub-status-live { color: #1e6a3f; }
.hub-status-soon { color: #5f635a; }
.hub-languages { margin: 0; font-size: 14px; }
.hub-languages a { font-weight: 700; }
.hub-catalog-card p.hub-local-only { padding-top: 12px; border-top: 1px solid var(--line); font-size: 14px; }
.hub-next { margin: 0; color: var(--muted); }
@media (max-width: 1050px) { .footer { grid-template-columns: repeat(3,1fr); } .footer-brand, .footer-note { grid-column: 1/-1; } }
@media (max-width: 760px) { @media (max-width: 430px) { .footer { grid-template-columns: 1fr; } .footer-brand, .footer-note { grid-column: 1; } }
`;
