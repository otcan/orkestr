// Versioned static publication sets this public meta value. API paths always
// remain at /api; ordinary startup without the meta keeps the existing root.
export function uiAssetUrl(name,document=globalThis.document,origin=globalThis.location.origin){
  if(!/^[a-zA-Z0-9_.-]+$/.test(name)||name==='.'||name==='..')throw Error('Invalid UI asset name');
  const pinned=/^\/_ui\/([0-9a-f]{64})\/(?:index\.html)?$/.exec(new URL(document.URL||origin).pathname);
  const base=document.querySelector('meta[name="orkestr-ui-assets"]')?.content||(pinned?`/_ui/${pinned[1]}/`:'/');
  if(base!=='/'&&!/^\/_ui\/[0-9a-f]{64}\/$/.test(base))throw Error('Invalid UI asset namespace');
  return new URL(base+name,origin).href;
}
