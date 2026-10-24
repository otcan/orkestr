import http from 'node:http';

export function requestOutreach(path, {method = 'GET', body, env = process.env, timeoutMs = 150_000} = {}) {
  if (!env.ORKESTR_OUTREACH_SOCKET || !env.ORKESTR_OUTREACH_TOKEN) throw new Error('outreach_scoped_client_unconfigured');
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let timer, response, failed = false;
    const unknown = () => {
      if (failed) return;
      failed = true; clearTimeout(timer);
      reject(new Error('outreach_result_unknown'));
      req.destroy(); response?.destroy();
    };
    const req = http.request({socketPath: env.ORKESTR_OUTREACH_SOCKET, path, method,
      headers: {authorization: `Bearer ${env.ORKESTR_OUTREACH_TOKEN}`,
        ...(payload ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)} : {})}}, res => {
      response = res;
      let text = '';
      res.setEncoding('utf8');
      res.on('error', unknown);
      res.on('data', chunk => {text += chunk; if (text.length > 65_536) unknown();});
      res.on('end', () => {
        clearTimeout(timer);
        try {resolve({status: res.statusCode, body: JSON.parse(text)});} catch {unknown();}
      });
    });
    timer = setTimeout(unknown, timeoutMs);
    req.once('error', () => {clearTimeout(timer); unknown();});
    req.end(payload);
  });
}
