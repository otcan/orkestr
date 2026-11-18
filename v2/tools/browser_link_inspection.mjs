// Fixed, read-only visible-anchor projection. Caller must hold its own managed
// desktop lease and apply its identity/site guards before invoking this module.
export async function inspectVisibleLink(evaluate, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 200 || /[\x00-\x1f]/.test(text)) throw new Error('link_text_invalid');
  return evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}.replace(/\\s+/g, ' ').trim().toLowerCase();
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href]')].filter(a => a.getClientRects().length && getComputedStyle(a).visibility !== 'hidden' && getComputedStyle(a).display !== 'none');
    const matches = anchors.filter(a => normalize(a.innerText || a.textContent).toLowerCase() === wanted);
    if (matches.length !== 1) {
      const textElements = matches.length ? [] : [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && normalize(e.innerText || e.textContent).toLowerCase() === wanted).slice(0, 8).map(e => ({tag:String(e.tagName || '').toLowerCase(),role:['link','button','checkbox'].includes(e.getAttribute('role'))?e.getAttribute('role'):'',has_href:e.hasAttribute('href'),has_onclick:e.hasAttribute('onclick'),inside_label:!!e.closest('label')}));
      return {ok:false,error:matches.length?'link_ambiguous':'link_not_found',count:matches.length,text_elements:textElements};
    }
    const a = matches[0];
    let u; try {u = new URL(a.getAttribute('href'), location.href);} catch {return {ok:false,error:'link_url_invalid'};}
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password) return {ok:false,error:'link_url_unsupported'};
    // Never disclose query parameters, fragments or signed download tokens.
    return {ok:true,text:normalize(a.innerText || a.textContent).slice(0,200),href:u.origin+u.pathname,parameters_omitted:!!(u.search||u.hash),target:['_blank','_self','_parent','_top'].includes(a.target)?a.target:'',download:a.hasAttribute('download')};
  })()`);
}
