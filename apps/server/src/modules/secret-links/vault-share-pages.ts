import { escapeHtml } from "../../browser-page-security.js";
import { sendSecretLinkPage } from "./secret-link-pages.js";

// Public recipient page for end-to-end vault share links
// (docs/vault-sharing.md). The decryption key is read from location.hash in
// the browser and never sent; the server only returns the envelope from
// POST /s/e/<token>/open. Mirrors packages/core/src/vault-share-crypto.js.

const recipientScript = `(function(){
var $=function(id){return document.getElementById(id);};var envelope=null;
function b64(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
function say(t){$("status").textContent=t;}
async function aesKey(frag,pass){var k=b64(frag);if(k.length!==32)throw new Error("key");if(!envelope.kdf)return k;
var pk=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveBits"]);
var bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:b64(envelope.kdf.salt),iterations:envelope.kdf.iterations},pk,256);
var hk=await crypto.subtle.importKey("raw",k,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
return new Uint8Array(await crypto.subtle.sign("HMAC",hk,bits));}
async function decrypt(){var frag=location.hash.slice(1);var pass=$("passphrase")?$("passphrase").value:"";
var key=await crypto.subtle.importKey("raw",await aesKey(frag,pass),"AES-GCM",false,["decrypt"]);
var plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64(envelope.iv)},key,b64(envelope.ct));
$("secret-value").value=new TextDecoder().decode(plain);$("result").hidden=false;$("open").hidden=true;
if($("pass-row"))$("pass-row").hidden=true;history.replaceState(null,"",location.pathname);say("");}
$("open").addEventListener("click",async function(){
if(!window.crypto||!crypto.subtle){say("This browser cannot decrypt here (a secure https connection is required).");return;}
if(!/^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1))){say("This link is incomplete: the part after # is missing. Ask the sender for the full link.");return;}
try{if(!envelope){var r=await fetch(location.pathname+"/open",{method:"POST",credentials:"omit",cache:"no-store"});
if(!r.ok){say("This link is not available.");$("open").hidden=true;return;}envelope=(await r.json()).envelope;}
await decrypt();}catch(e){say(envelope&&envelope.kdf?"Could not decrypt. Check the passphrase and press Reveal again.":"Could not decrypt this secret. The link may be damaged.");}});
$("copy").addEventListener("click",function(){var f=$("secret-value");f.select();if(navigator.clipboard){navigator.clipboard.writeText(f.value).catch(function(){document.execCommand("copy");});}else{document.execCommand("copy");}this.textContent="Copied";});
})();`;

export function vaultSharePromptPage(response: any, link: any) {
  const remaining = Math.max(0, Number(link?.maxViews || 1) - Number(link?.views || 0));
  const passRow = link?.passphrase
    ? `<p id="pass-row"><label>Passphrase (the sender tells you separately)<br><input id="passphrase" type="password" autocomplete="off"></label></p>`
    : "";
  return sendSecretLinkPage(response, 200, "A secret was shared with you", `${link?.label ? `<p>${escapeHtml(link.label)}</p>` : ""}
<p>Someone shared a secret with you through Orkestr. It is decrypted in this browser only; the server never sees it.</p>
<p class="muted">Reveal works ${remaining === 1 ? "one more time" : `${remaining} more times`}; the link expires at ${escapeHtml(link?.expiresAt || "")}.</p>
${passRow}<button type="button" id="open">Reveal</button><p id="status" role="status"></p>
<div id="result" hidden><textarea id="secret-value" rows="4" readonly autocomplete="off" spellcheck="false"></textarea>
<button type="button" id="copy">Copy</button></div>`, { script: recipientScript, connect: true });
}

export function vaultShareUnavailablePage(response: any) {
  return sendSecretLinkPage(response, 404, "Link not available", "<p>This link does not exist, was already used, was revoked, or has expired.</p>");
}

export function sendVaultShareJson(response: any, status: number, payload: unknown) {
  return response.status(status)
    .header("cache-control", "no-store, max-age=0")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex, nofollow")
    .header("x-orkestr-secure-input", "noMirror,noCapture,noCodexContext,noScreenshot")
    .json(payload);
}
