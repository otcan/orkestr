import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selfChatError } from './whatsapp-owner-selfchat-journal.js';
import { ownerSelfChatWrapperEnvironment, assertOwnerSelfChatWrapperEnvironment } from './whatsapp-owner-selfchat-wrapper-config.js';
const execute=promisify(execFile);

export async function assertRootOwnedPath(filename, { directory=false, privateFile=false } = {}) {
  if (!path.isAbsolute(filename)) throw selfChatError('selfchat_absolute_path_required');
  let current=filename;
  while (true) {
    const stat=await fs.lstat(current);
    if (stat.isSymbolicLink() || stat.uid!==0 || (stat.mode & 0o022))
      throw selfChatError('selfchat_operator_path_not_protected');
    if (current===filename && (directory ? !stat.isDirectory() : !stat.isFile()))
      throw selfChatError('selfchat_operator_path_type');
    if (current===filename && privateFile && (stat.mode & 0o077))
      throw selfChatError('selfchat_private_file_permissions');
    const parent=path.dirname(current); if(parent===current) break; current=parent;
  }
}

// Called only by the operator adapter after installation approval. No start,
// mkdir, stop, token read, token creation or session reset is available here.
export function createOwnerSelfChatWrapper(config, executeImpl=execute) {
  if(!config.requiredDirectories?.length || !config.requiredFiles?.length || !config.implementationPaths?.length)
    throw selfChatError('selfchat_wrapper_preconditions_required');
  const wrapperEnvironment=ownerSelfChatWrapperEnvironment(config);
  const fixedEnv={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'};
  async function preflight() {
    await assertRootOwnedPath(config.wrapperPath);
    await assertRootOwnedPath('/usr/bin/node');
    // The installed executable may import a separate root-owned implementation.
    for (const filename of config.implementationPaths || []) await assertRootOwnedPath(filename);
    for (const directory of config.requiredDirectories || []) {
      await assertRootOwnedPath(directory,{directory:true});
    }
    for (const filename of config.requiredFiles || []) {
      await assertRootOwnedPath(filename);
      const st=await fs.lstat(filename);
      if (!st.size) throw selfChatError('selfchat_runtime_missing');
    }
    if (!/^[A-Za-z0-9_.@-]+\.service$/.test(config.existingService || ''))
      throw selfChatError('selfchat_service_required');
    const {stdout}=await executeImpl('/usr/bin/systemctl',
      ['show',config.existingService,'--property=ActiveState','--property=MainPID','--property=InvocationID'],
      {env:fixedEnv,timeout:5000,maxBuffer:4096});
    const fields=Object.fromEntries(stdout.trim().split('\n').map(line=>line.split('=')));
    if (fields.ActiveState!=='active' || !/^[1-9]\d*$/.test(fields.MainPID || '') || !/^[a-f0-9]{32}$/.test(fields.InvocationID || ''))
      throw selfChatError('selfchat_existing_service_inactive');
    const runtimeId=`${config.existingService}:${fields.MainPID}:${fields.InvocationID}`;
    assertOwnerSelfChatWrapperEnvironment(config,wrapperEnvironment,runtimeId);
    return runtimeId;
  }
  async function invoke(argv, {runtimeId,isActive=()=>true}={}) {
    const current=await preflight();
    if(!isActive()) throw selfChatError('selfchat_adapter_closed');
    if(runtimeId && current!==runtimeId) throw selfChatError('selfchat_runtime_changed');
    if (!['status','history','send-text','identity'].includes(argv[0])) throw selfChatError('selfchat_wrapper_operation_denied');
    if(argv[0]==='identity' && (config.identityVerificationMode!=='live-account'
        || argv.length!==2 || !/^[a-f0-9]{32}$/.test(argv[1])))throw selfChatError('selfchat_wrapper_operation_denied');
    try {
      const {stdout}=await executeImpl('/usr/bin/node',[config.wrapperPath,...argv],{env:{...fixedEnv,...wrapperEnvironment},timeout:30000,maxBuffer:1024*1024});
      return JSON.parse(stdout);
    } catch { throw selfChatError('selfchat_wrapper_request_failed',502); }
  }
  return {preflight,invoke};
}
