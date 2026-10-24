#!/usr/bin/env node
// Dedicated delegate credential only; never use a coordinator token here.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const usage = `Usage: whatsapp-delegate-cli.mjs <command>
  health | cap
  chats [--cursor C] [--limit N] [--unread]
  read CHAT [--before MSG] [--limit N]
  send|dry-run CHAT TEXT|- --request-id ID
  react CHAT MSG EMOJI --request-id ID
  sends|reactions [--state STATE]
Requires ORKESTR_WA_DELEGATE_URL (loopback HTTP) and
ORKESTR_WA_DELEGATE_TOKEN_FILE (dedicated scoped credential).
Reads never mark seen. Reaction writes require server opt-in.`;
const fail = () => {throw new Error('delegate_cli_arguments_invalid');};

export function delegateCommand(args) {
  const positions = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!['cursor', 'limit', 'unread', 'before', 'request-id', 'state'].includes(key) || Object.hasOwn(options, key)) fail();
      if (key === 'unread') options[key] = true;
      else {if (!args[i + 1] || args[i + 1].startsWith('--')) fail();options[key] = args[++i];}
    } else positions.push(arg);
  }
  const [command, chat, value, emoji] = positions;
  const shapes = {health:[1,[]],cap:[1,[]],chats:[1,['cursor','limit','unread']],read:[2,['before','limit']],
    send:[3,['request-id']],'dry-run':[3,['request-id']],react:[4,['request-id']],sends:[1,['state']],reactions:[1,['state']]};
  const shape = shapes[command];
  if (!shape || positions.length !== shape[0] || Object.keys(options).some(key => !shape[1].includes(key))) fail();
  const query = new URLSearchParams();
  for (const [key, val] of Object.entries(options)) if (key !== 'request-id') query.set(key === 'unread' ? 'unread_only' : key, val === true ? '1' : val);
  const suffix = query.size ? `?${query}` : '';
  if (['send', 'dry-run', 'react'].includes(command)) {
    if (!options['request-id']) fail();
    return {method:'POST',path:`/delegate/${command === 'dry-run' ? 'send-dry-run' : command}`,body:command === 'react'
      ? {to:chat,messageId:value,emoji,requestId:options['request-id']}
      : {to:chat,text:value,requestId:options['request-id']}};
  }
  return {method:'GET',path:(command === 'read' ? `/delegate/chats/${encodeURIComponent(chat)}/messages` : `/delegate/${command}`) + suffix};
}

export async function runDelegateCli({args = process.argv.slice(2), env = process.env, fetchImpl = fetch, readFile = fs.readFile, write = text => process.stdout.write(text)} = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {write(`${usage}\n`);return 0;}
  try {
    const command = delegateCommand(args);
    const url = new URL(env.ORKESTR_WA_DELEGATE_URL);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('delegate_cli_loopback_url_required');
    if (!env.ORKESTR_WA_DELEGATE_TOKEN_FILE) throw new Error('delegate_cli_token_file_required');
    let token;
    try {token = (await readFile(env.ORKESTR_WA_DELEGATE_TOKEN_FILE, 'utf8')).trim();} catch {throw new Error('delegate_cli_credential_unavailable');}
    if (!token) throw new Error('delegate_cli_credential_unavailable');
    if (command.body?.text === '-') command.body.text = (await readFile(0, 'utf8')).replace(/\n$/, '');
    const response = await fetchImpl(new URL(command.path, url), {method:command.method, redirect:'error',signal:AbortSignal.timeout(120_000),
      headers:{authorization:`Bearer ${token}`,...(command.body ? {'content-type':'application/json'} : {})},
      ...(command.body ? {body:JSON.stringify(command.body)} : {})});
    const result = await response.json();
    write(`${JSON.stringify(result, null, 2)}\n`);
    return response.ok && result.ok !== false ? 0 : 1;
  } catch (error) {
    // Native filesystem/network errors can include private URLs/paths. Only
    // this CLI's fixed codes are exposed; never log headers or credentials.
    const code = /^delegate_cli_[a-z_]+$/.test(error?.message || '') ? error.message : 'delegate_cli_request_failed';
    write(`${JSON.stringify({ok:false,error:code})}\n`);return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runDelegateCli();
