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
.team-directory { grid-template-columns: minmax(260px,.55fr) minmax(0,1.45fr); align-items: start; background: #ebe6d8; }
.team-directory-heading { position: sticky; top: 108px; }
.team-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; max-width: 760px; }
.team-member-card { min-width: 0; border: 1px solid var(--line); background: var(--panel); text-align: center; }
.team-member-card img { display: block; width: clamp(118px,14vw,172px); height: clamp(118px,14vw,172px); margin: clamp(22px,3vw,32px) auto 0; border-radius: 999px; border: 1px solid var(--line); object-fit: cover; filter: saturate(.86) contrast(1.02); }
.team-member-card div { padding: clamp(16px,2.4vw,26px) clamp(18px,2.6vw,28px) clamp(22px,3vw,32px); }
.team-member-card h3 { font-size: clamp(23px,2.4vw,34px); }
.team-member-card p { margin: 10px 0 0; color: var(--muted); font: 740 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; text-transform: uppercase; }
@media (max-width: 1080px) { .header-actions .button-small { display: none; } }
@media (max-width: 760px) { .team-directory { grid-template-columns: 1fr; } .team-directory-heading { position: static; } }
@media (max-width: 560px) { .team-grid { grid-template-columns: 1fr; max-width: 420px; } .team-member-card { display: grid; grid-template-columns: auto minmax(0,1fr); text-align: left; align-items: center; } .team-member-card img { width: 88px; height: 88px; margin: 16px 0 16px 16px; } .team-member-card div { padding: 16px 18px; } .team-member-card h3 { font-size: 24px; } }
`;
