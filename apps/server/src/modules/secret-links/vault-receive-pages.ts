import { escapeHtml } from "../../browser-page-security.js";
import { sendSecretLinkPage } from "./secret-link-pages.js";

// Public submit page for Vault receive links (docs/vault-sharing.md). The
// browser encrypts { u, p } with a fresh AES-256-GCM key, wraps that key with
// the link's RSA-OAEP-SHA256 public key, and posts only the envelope to
// POST /s/r/<token>/submit. Mirrors packages/core/src/vault-receive-links.js.

const submitScript = `(function(){
var $=function(id){return document.getElementById(id);};var form=$("receive");
function b64(u){var s="";u=new Uint8Array(u);for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}
function unb64(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
function say(t){$("status").textContent=t;}
form.addEventListener("submit",async function(ev){ev.preventDefault();
if(!window.crypto||!crypto.subtle){say("This browser cannot encrypt here (a secure https connection is required).");return;}
var p=$("password").value;if(!p){say("Enter the password.");return;}
$("send").disabled=true;say("Encrypting…");
try{var pub=await crypto.subtle.importKey("spki",unb64(form.getAttribute("data-key")),{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);
var raw=crypto.getRandomValues(new Uint8Array(32));var iv=crypto.getRandomValues(new Uint8Array(12));
var aes=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt"]);
var ct=await crypto.subtle.encrypt({name:"AES-GCM",iv:iv},aes,new TextEncoder().encode(JSON.stringify({u:$("username").value,p:p})));
var wk=await crypto.subtle.encrypt({name:"RSA-OAEP"},pub,raw);raw.fill(0);
var env={v:1,alg:"RSA-OAEP-256+A256GCM",wk:b64(wk),iv:b64(iv),ct:b64(ct)};
var r=await fetch(location.pathname+"/submit",{method:"POST",credentials:"omit",cache:"no-store",body:new URLSearchParams({envelope:JSON.stringify(env)})});
if(r.ok){form.hidden=true;$("password").value="";say("Sent. The password was encrypted in this browser and stored in the recipient's vault. You can close this page.");return;}
say(r.status===413?"The password is too long.":r.status===400?"The password could not be stored. Try again.":"This link is not available any more.");if(r.status===400||r.status===413)$("send").disabled=false;}
catch(e){say("Encryption failed in this browser.");$("send").disabled=false;}});
})();`;

export function vaultReceivePromptPage(response: any, link: any, publicKey: string) {
  return sendSecretLinkPage(response, 200, `Send a password: ${link?.name || ""}`, `${link?.label ? `<p>${escapeHtml(link.label)}</p>` : ""}
<p>Someone asked you for the password <strong>${escapeHtml(link?.name)}</strong>. It is encrypted in this browser before it is sent and goes straight into their Orkestr vault. This link works once.</p>
<p class="muted">The link expires at ${escapeHtml(link?.expiresAt || "")}.</p>
<form id="receive" data-key="${escapeHtml(publicKey)}">
<p><label>Username (optional)<br><input id="username" autocomplete="off" maxlength="500"></label></p>
<p><label>Password<br><textarea id="password" rows="3" maxlength="16384" required autocomplete="off" spellcheck="false"></textarea></label></p>
<button type="submit" id="send">Encrypt and send</button></form><p id="status" role="status"></p>`, { script: submitScript, connect: true });
}
