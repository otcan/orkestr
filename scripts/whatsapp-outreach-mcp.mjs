#!/usr/bin/env node
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {requestOutreach} from '../packages/connectors/src/whatsapp-outreach-client.js';

// Dedicated, thread-local MCP, not a router account or another WhatsApp browser.
// Scope is enforced again at the protected socket using a different credential
// for each source account. Never set the coordinator token in this environment.
const accountId = process.env.ORKESTR_OUTREACH_ACCOUNT_ID;
const threadId = process.env.ORKESTR_OUTREACH_THREAD_ID;
if (!accountId || !threadId) throw new Error('outreach_scoped_client_unconfigured');
const server = new Server({name: 'scoped-whatsapp-outreach', version: '1.0.0'}, {capabilities: {tools: {}}});
const object = properties => ({type: 'object', properties, additionalProperties: false, required: Object.keys(properties)});
const string = {type: 'string', minLength: 1};
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [
  {name: 'outreach_status', description: 'Scoped admission status and rolling quota. Does not send or start an account.', inputSchema: object({})},
  {name: 'outreach_send_text', description: 'One authorized new-recipient text. Scope, rolling cap, window and spacing are enforced server-side. Never retry uncertain delivery or switch accounts.',
    inputSchema: object({conversation_id: string, text: string, idempotency_key: string})},
  {name: 'outreach_receipt', description: 'Inspect original request outcome without sending or replaying it.', inputSchema: object({idempotency_key: string})},
  {name: 'outreach_stop', description: 'Permanently stop this campaign when the owner stops it or the official Cloud API is approved. No resume operation.',
    inputSchema: object({reason: {type: 'string', enum: ['owner_stop', 'official_cloud_api_approved']}})},
]}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name, args = request.params.arguments || {};
  let result;
  try {
    const keys = Object.keys(args).sort().join(',');
    if (name === 'outreach_status' && keys === '') result = await requestOutreach('/health');
    else if (name === 'outreach_send_text' && keys === 'conversation_id,idempotency_key,text'
        && [args.conversation_id, args.text, args.idempotency_key].every(value => typeof value === 'string'))
      result = await requestOutreach('/send-text', {method: 'POST', body: {accountId, threadId,
        to: args.conversation_id, text: args.text, requestId: args.idempotency_key}});
    else if (name === 'outreach_receipt' && keys === 'idempotency_key' && /^[A-Za-z0-9:._-]{1,160}$/.test(args.idempotency_key || ''))
      result = await requestOutreach(`/receipts/${args.idempotency_key}`);
    else if (name === 'outreach_stop' && keys === 'reason' && ['owner_stop', 'official_cloud_api_approved'].includes(args.reason))
      result = await requestOutreach('/stop', {method: 'POST', body: {reason: args.reason}});
    else throw new Error('outreach_tool_scope_denied');
    return {content: [{type: 'text', text: JSON.stringify(result.body)}], isError: result.status !== 200};
  } catch (error) {
    return {content: [{type: 'text', text: JSON.stringify({ok: false,
      error: error?.message === 'outreach_tool_scope_denied' ? error.message : 'outreach_result_unknown',
      action: 'Inspect the original receipt; do not resend or switch accounts.'})}], isError: true};
  }
});
await server.connect(new StdioServerTransport());
