import fs from 'node:fs/promises';
import { createOwnerSelfChatPump } from './whatsapp-owner-selfchat-pump.js';
import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';
import { assertRootOwnedPath } from './whatsapp-owner-selfchat-wrapper.js';

// Keep the diagnostic useful without recording provider errors or message text.
export function ownerSelfChatFailureCode(error) {
  const code=error?.message;
  return typeof code==='string' && /^(?:selfchat_|owner_selfchat_)[a-z_]{1,96}$/.test(code)
    ? code : 'selfchat_unexpected_error';
}

export async function readOwnerSelfChatRuntimeConfig(filename, env) {
  await assertRootOwnedPath(filename);
  const config=JSON.parse(await fs.readFile(filename,'utf8'));
  if(config.activationApproved!==true || config.home!==env.ORKESTR_HOME || config.scope?.enabled!==true)
    throw selfChatError('selfchat_activation_approval_required');
  return config;
}

// Runs inside the existing server, not a second process writing router state.
// No installation, registration, account startup, general queue sweep or retry.
/**
 * @param {Record<string,string|undefined>} env
 * @param {{routeInbound?: (input:any, env:any)=>Promise<any>, track?: (promise:Promise<any>)=>any,
 * onError?: (error:any)=>any, readConfig?: (filename:string, env:any)=>Promise<any>, intervalMs?:number}} options
 */
export async function startOwnerSelfChatPolling(env,{routeInbound,track=promise=>promise,onError=()=>{},
  readConfig=readOwnerSelfChatRuntimeConfig,intervalMs=5000}={}) {
  const filename=env.ORKESTR_OWNER_SELFCHAT_CONFIG;
  if(!filename) return {enabled:false,close:()=>{}};
  let config;
  try {config=await readConfig(filename,env);}
  catch(error) {onError(error);return {enabled:false,close:()=>{}};}
  const scopeEnv={...env,ORKESTR_WHATSAPP_API_AGENT_AUTORUN:'0',
    ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:JSON.stringify(config.scope)};
  const revision=selfChatHash(config);let active=false,closed=false;
  const assertActive=async()=>{
    const fresh=await readConfig(filename,env);
    if(closed || selfChatHash(fresh)!==revision) throw selfChatError('selfchat_scope_changed');
  };
  let tick;
  try {tick=createOwnerSelfChatPump({env:scopeEnv,routeInbound,assertActive});}
  catch(error) {onError(error);return {enabled:false,close:()=>{}};}
  const run=async()=>{
    if(active || closed) return;active=true;
    try {
      await assertActive();
      await tick();
    } catch(error) {closed=true;clearInterval(timer);onError(error);}
    finally {active=false;}
  };
  const timer=setInterval(()=>track(run()),Math.max(1000,intervalMs));timer.unref?.();
  return {enabled:true,close:()=>{closed=true;clearInterval(timer);}};
}
