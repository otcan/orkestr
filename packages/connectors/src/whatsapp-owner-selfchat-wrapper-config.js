import path from 'node:path';
import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';

const suffixes=['STATE_DIR','SESSION_DIR','TOKEN_FILE','HOST','PORT'];

// Operator config pins the existing endpoint and path references, never secrets.
// Do not inherit service/process environment or silently use wrapper defaults.
export function ownerSelfChatWrapperEnvironment(config) {
  const prefix=config.wrapperEnvironmentPrefix;
  if(typeof prefix!=='string' || !/^WA_[A-Z0-9_]{1,64}_$/.test(prefix))
    throw selfChatError('selfchat_wrapper_environment_prefix_required');
  const keys=suffixes.map(suffix=>prefix+suffix);
  const input=config.wrapperEnvironment;
  if(!input || typeof input!=='object' || Array.isArray(input)
      || Object.keys(input).length!==keys.length || Object.keys(input).some(key=>!keys.includes(key)))
    throw selfChatError('selfchat_wrapper_environment_required');
  const env=Object.fromEntries(keys.map(key=>[key,input[key]]));
  if(Object.values(env).some(value=>typeof value!=='string' || !value || value.length>4096
      || value!==value.trim() || /[\x00-\x1f\x7f]/.test(value)))
    throw selfChatError('selfchat_wrapper_environment_invalid');
  for(const key of keys.slice(0,3)) {
    if(!path.isAbsolute(env[key]) || path.normalize(env[key])!==env[key])
      throw selfChatError('selfchat_wrapper_environment_invalid');
  }
  if(env[prefix+'HOST']!=='127.0.0.1' || !/^[1-9]\d{0,4}$/.test(env[prefix+'PORT'])
      || Number(env[prefix+'PORT'])>65535)
    throw selfChatError('selfchat_wrapper_endpoint_invalid');
  if(!config.requiredDirectories?.includes(env[prefix+'STATE_DIR'])
      || !config.requiredDirectories?.includes(env[prefix+'SESSION_DIR'])
      || !config.requiredDirectories?.includes(path.dirname(env[prefix+'TOKEN_FILE']))
      || !config.requiredFiles?.includes(env[prefix+'TOKEN_FILE']))
    throw selfChatError('selfchat_wrapper_environment_path_mismatch');
  return Object.freeze(env);
}

export function assertOwnerSelfChatWrapperEnvironment(config,environment,runtimeId) {
  const proof=config.verifiedWrapperEnvironment;
  if(proof?.runtimeId!==runtimeId || proof.environmentHash!==selfChatHash(environment))
    throw selfChatError('selfchat_wrapper_environment_unverified');
}
