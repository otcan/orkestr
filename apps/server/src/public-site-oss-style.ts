export const publicSiteOssCss = `
.page-open-source .page-hero .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
.page-open-source .oss-boundary dd { font-size: 17px; }
.oss-sim-flag { display: inline-block; margin-right: 6px; padding: 3px 8px; border: 1px solid #f0b39f; color: #ffd8cb; font: 760 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; }
.code-section code, .oss-real code, .oss-hint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.oss-real, .oss-docs { grid-template-columns: .65fr 1.35fr; }
.oss-status { grid-template-columns: 1fr; }
.oss-code { min-width: 0; margin: 0; padding: 26px; overflow-x: auto; border: 1px solid #35443a; background: #0b120e; color: #d9e5da; line-height: 1.7; }
.oss-hint { margin: 18px 0 0; color: var(--muted); line-height: 1.5; }
.oss-table-wrap { min-width: 0; overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
.oss-status-table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 15px; line-height: 1.45; }
.oss-status-table caption { padding: 16px 18px; text-align: left; color: var(--muted); font: 700 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
.oss-status-table th, .oss-status-table td { padding: 16px 18px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
.oss-status-table thead th { color: var(--muted); font-size: 13px; }
.oss-status-table tbody th { min-width: 150px; font-weight: 800; }
.oss-status-table td:last-child { color: var(--muted); }
.oss-evidence { display: inline-block; padding: 3px 8px; border: 1px solid currentColor; border-radius: 3px; font: 760 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
.oss-evidence-simulation { color: #7a4d00; background: #fff4d6; }
.oss-evidence-offline-tested { color: #1f4f7a; background: #e6f0fa; }
.oss-evidence-live-verified { color: #1d5b33; background: #e3f3e8; }
.oss-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin: 0; }
.oss-legend div { display: grid; gap: 10px; align-content: start; }
.oss-legend dt { margin: 0; }
.oss-legend dd { margin: 0; color: var(--muted); line-height: 1.5; }
.oss-doc-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.oss-doc-list li { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 20px; padding: 18px 0; border-top: 1px solid var(--line); }
.oss-doc-list a { font-weight: 800; overflow-wrap: anywhere; }
.oss-doc-list span { color: var(--muted); line-height: 1.5; }
@media (max-width: 860px) {
  .oss-real, .oss-docs { grid-template-columns: 1fr; }
  .oss-legend { grid-template-columns: 1fr; }
  .oss-doc-list li { grid-template-columns: 1fr; gap: 6px; }
}
`;
