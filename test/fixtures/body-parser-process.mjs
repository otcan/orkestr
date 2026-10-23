// Isolated test server; never imports Orkestr state or binds a public interface.
import http from 'node:http';
import {createRequire} from 'node:module';
// `node --test` can discover this fixture too. Only its explicit IPC parent
// may start the server; discovery/import must leave no listening handle.
if (process.env.ORKESTR_BODY_PARSER_FIXTURE === '1' && process.send) {
const require = createRequire(import.meta.url);
const parser = require(process.argv[2] || 'body-parser').json();
const sockets = new Set();
const server = http.createServer((request, response) => {
  request.once('end', () => setImmediate(() => process.send?.({drained: true})));
  if (request.url === '/alive') {response.end('alive'); return;}
  parser(request, response, error => {
    response.statusCode = error ? 400 : 200;
    response.end(error ? 'invalid' : JSON.stringify(request.body));
  });
});
server.on('connection', socket => {sockets.add(socket); socket.once('close', () => sockets.delete(socket));});
server.listen(0, '127.0.0.1', () => process.send?.({port: server.address().port}));
process.on('message', message => {
  if (message === 'stop') {for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0));}
});
}
