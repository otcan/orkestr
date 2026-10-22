import crypto from 'node:crypto';
import http from 'node:http';
import {outreachError} from './whatsapp-outreach-policy.js';

// Unix-socket only. Each dedicated bearer is bound to ONE account and the
// policy's thread, not to the coordinator's broad credential. No read/auth/
// resolve/import/resume endpoints exist on this server. Stop is one-way only.
export function createOutreachHttpServer({policy, sender, grants}) {
  if (!Array.isArray(grants) || !grants.length || grants.some(grant =>
    !grant || !policy.accounts.includes(grant.accountId) || !/^[a-f0-9]{64}$/.test(grant.tokenSha256 || '')
    || Object.keys(grant).some(key => !['accountId', 'tokenSha256'].includes(key)))
    || new Set(grants.map(grant => grant.tokenSha256)).size !== grants.length)
    throw outreachError('grant_invalid');
  const authorization = request => {
    const match = /^Bearer ([^\s]{32,256})$/.exec(request.headers.authorization || '');
    if (!match) throw outreachError('unauthorized', 401);
    const supplied = crypto.createHash('sha256').update(match[1]).digest();
    const grant = grants.find(value => crypto.timingSafeEqual(supplied, Buffer.from(value.tokenSha256, 'hex')));
    if (!grant) throw outreachError('unauthorized', 401);
    return grant;
  };
  const server = http.createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      response.end(JSON.stringify(body));
    };
    try {
      const grant = authorization(request);
      if (request.method === 'GET' && request.url === '/health') {
        const status = await sender.status();
        return json(200, {ok: true, accountId: grant.accountId, threadId: policy.threadId,
          ...status, quota: status.quota.filter(row => row.accountId === grant.accountId)});
      }
      const receipt = /^\/receipts\/([A-Za-z0-9:._-]{1,160})$/.exec(request.url || '');
      if (request.method === 'GET' && receipt) return json(200, await sender.receipt(grant.accountId, receipt[1]));
      if (request.method !== 'POST' || !['/send-text', '/stop'].includes(request.url)) throw outreachError('route_denied', 403);
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw outreachError('body_invalid', 400);
      let bytes = 0; const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 32_768) throw outreachError('body_too_large', 413);
        chunks.push(chunk);
      }
      let body;
      try {body = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw outreachError('body_invalid', 400);}
      if (request.url === '/stop') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw outreachError('stop_invalid', 400);
        return json(200, sender.stop(body.reason));
      }
      if (!body || Array.isArray(body) || typeof body !== 'object'
          || Object.keys(body).some(key => !['accountId', 'threadId', 'to', 'text', 'requestId'].includes(key))
          || body.accountId !== grant.accountId || body.threadId !== policy.threadId)
        throw outreachError('scope_denied');
      return json(200, await sender.send(body));
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      // No backend errors, credential material, text or recipients in responses.
      const message = /^outreach_[a-z_]+$/.test(error?.message || '') ? error.message : 'outreach_failed';
      json(error?.statusCode || 500, {ok: false, error: message});
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 20;
  return server;
}
