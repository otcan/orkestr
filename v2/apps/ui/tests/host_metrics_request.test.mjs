import test from 'node:test';
import assert from 'node:assert/strict';
import {hostMetricsRequest} from '../src/host_metrics_request.mjs';

test('reads summary and history with cookie-only GETs and returns the ETag', async () => {
 for (const path of ['/api/v2/host-metrics', '/api/v2/host-metrics/history?range=15m', '/api/v2/host-metrics/history?range=7d', '/api/v2/host-metrics/consumers', '/api/v2/host-metrics/disks', '/api/v2/host/ai-usage']) {
  const result = await hostMetricsRequest({path}, async (actual, o) => {
   assert.equal(actual, path); assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'same-origin'); assert.deepEqual(o.headers, {});
   return new Response('{"schema_version":1}', {headers:{etag:'W/"abc"'}});
  });
  assert.deepEqual(result, {status:200, etag:'W/"abc"', text:'{"schema_version":1}'});
 }
});
test('revalidates with a plain ETag only and passes 304 through', async () => {
 const sent = [];
 const fetcher = async (_, o) => { sent.push(o.headers); return new Response(null, {status:304}); };
 assert.deepEqual(await hostMetricsRequest({path:'/api/v2/host-metrics', etag:'W/"abc"'}, fetcher), {status:304, etag:null, text:''});
 await hostMetricsRequest({path:'/api/v2/host-metrics', etag:'"x"\r\nX-Evil: 1'}, fetcher);
 assert.deepEqual(sent, [{'If-None-Match':'W/"abc"'}, {}]);
});
test('other paths refuse before network; failures degrade to status 0', async () => {
 for (const path of ['/api/v2/host-metrics/history?range=2h', '/api/v2/resources', '/api/v2/host/ai-usage?x=1', '/api/v2/host/other', '//evil/api/v2/host-metrics', null])
  await assert.rejects(hostMetricsRequest({path}, () => assert.fail('network')));
 assert.deepEqual(await hostMetricsRequest({path:'/api/v2/host-metrics'}, async () => { throw Error('offline'); }), {status:0, etag:null, text:''});
 assert.deepEqual(await hostMetricsRequest({path:'/api/v2/host-metrics'}, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), {status:0, etag:null, text:''});
});
