// The HTTP server around the app's request handler. One bad request must never take the
// process down: a handler that throws or rejects answers 500 and the server keeps serving,
// and a request Node's parser refuses gets a 400 on the raw socket.
import http from 'node:http';

export function createServer(handler, { log = console.error } = {}) {
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch((error) => {
      log('[http]', error?.stack || error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Something failed on the server. Try again.');
      } else res.end();
    });
  });
  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) { socket.destroy(); return; }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}
