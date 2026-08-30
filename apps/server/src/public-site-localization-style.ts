export const publicSiteLocalizationCss = `
.language-switcher { display: inline-flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--line); background: rgba(255,255,255,.34); }
.language-switcher a { display: grid; place-items: center; min-width: 31px; min-height: 30px; padding: 0 6px; color: var(--muted); font: 760 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-decoration: none; }
.language-switcher a:hover, .language-switcher a[aria-current="page"] { background: var(--ink); color: #fff; }
.locale-de .v4-hero h1 { overflow-wrap: normal; font-size: clamp(52px,6.4vw,92px); }
.locale-de .walkthrough li, .locale-tr .walkthrough li { min-width: 0; }
.locale-de .walkthrough strong, .locale-tr .walkthrough strong { overflow-wrap: anywhere; }
.mobile-language-switcher { display: flex; margin-top: 7px; }
.mobile-language-switcher a { display: grid !important; min-width: 42px; padding: 8px !important; text-align: center; }
.team-hero .lead { max-width: 760px; }
.team-profile { grid-template-columns: minmax(300px,.72fr) minmax(0,1.28fr); align-items: start; background: #ebe6d8; }
.founder-card { display: grid; gap: 28px; padding: clamp(26px,4vw,48px); border: 1px solid var(--line); background: var(--panel); }
.founder-monogram { display: grid; place-items: center; width: 112px; height: 112px; border-radius: 50%; background: var(--dark); color: #fff; font: 800 29px ui-monospace, SFMono-Regular, Menlo, monospace; }
.founder-card h2 { font-size: clamp(36px,4vw,58px); }
.founder-card div > p:last-child { color: var(--muted); font-size: 17px; line-height: 1.6; }
.team-work { display: grid; gap: 1px; border: 1px solid var(--line); background: var(--line); }
.team-work article { padding: clamp(24px,3vw,38px); background: var(--panel); }
.team-work article > span { color: var(--accent); font: 760 11px ui-monospace, monospace; }
.team-work h3 { margin-top: 22px; }
.team-work p { color: var(--muted); line-height: 1.55; }
.team-principle { grid-template-columns: minmax(0,1.25fr) minmax(280px,.75fr); align-items: end; background: var(--dark); color: #fff; }
.team-principle blockquote { margin: 0; font-size: clamp(34px,5vw,68px); font-weight: 820; line-height: 1; letter-spacing: -.05em; }
.team-principle p { margin: 0; color: #aeb9b0; font-size: 17px; line-height: 1.6; }
@media (max-width: 1080px) { .header-actions .button-small { display: none; } }
@media (max-width: 760px) { .team-profile, .team-principle { grid-template-columns: 1fr; } }
`;
