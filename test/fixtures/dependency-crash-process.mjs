import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PassThrough} from 'node:stream';
import http from 'node:http';

// Explicit child invocation only; default test discovery must remain inert.
if (process.env.ORKESTR_DEPENDENCY_CRASH_FIXTURE === '1' && process.argv[2] === '--isolated') {
  const load = createRequire(import.meta.url);
  const kind = process.argv[3];
  const deadline = setTimeout(() => {throw new Error('synthetic fixture timeout');}, 4000);
  if (kind === 'multer') {
    // GHSA-q7qp-rjg7-q26m: two pending filters, teardown, then late resume
    // of the first real file stream. No synthetic error listener masks a crash.
    const multer = load(process.argv[4] || 'multer');
    const input = new PassThrough();
    const boundary = 'SyntheticMultipartBoundary';
    const bytes = Buffer.from(['first', 'second'].map(name =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.txt"\r\n` +
      'Content-Type: text/plain\r\n\r\nx\r\n').join(''));
    input.headers = {'content-type': `multipart/form-data; boundary=${boundary}`,
                     'content-length': bytes.length};
    let pending, parser, callbacks = 0;
    const refusal = new Error('synthetic filter refusal');
    await new Promise((resolve, reject) => {
      multer({fileHwm: 1, storage: multer.memoryStorage(),
        streamHandler(request, stream) {parser = stream; request.pipe(stream);},
        fileFilter(request, file, next) {
          if (file.fieldname === 'first') pending = next;
          else request.once('end', () => setImmediate(() => next(refusal)));
        },
      }).any()(input, {}, error => {
        callbacks++;
        if (error !== refusal || typeof pending !== 'function') return reject(error || new Error('missing filter'));
        setImmediate(() => {
          parser.once('close', resolve);
          pending(null, true);
        });
      });
      input.end(bytes);
    });
    assert.equal(callbacks, 1);
    assert.deepEqual(input.files, []);
  } else if (kind === 'undici') {
    // GHSA-xjj6-f33q-929c: reject excessive encodings, then handle the
    // truncated body without an unhandled error on an orphaned stream.
    const {fetch} = load(process.argv[4] || 'undici');
    const server = http.createServer((request, response) => {
      if (request.url === '/healthy') return response.end('alive');
      request.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n' +
        'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nConnection: close\r\n\r\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      await assert.rejects(fetch(origin), TypeError);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await (await fetch(`${origin}/healthy`)).text(), 'alive');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  } else {
    throw new Error('unknown synthetic fixture');
  }
  clearTimeout(deadline);
  console.log(JSON.stringify({survived: true, kind}));
}
