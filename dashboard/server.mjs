import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.SMARTSPORT_PORT || 8080);
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};
const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, {Allow: 'GET, HEAD'}); response.end(); return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const local = relative(root, filename);
    if (local === '..' || local.startsWith(`..${sep}`) || local.includes(':') || filename.includes('\0')) {
      response.writeHead(403); response.end('Forbidden'); return;
    }
    const content = await readFile(filename);
    response.writeHead(200, {'Content-Type': types[extname(filename)] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}); response.end('Not found');
  }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. If the dashboard is running, open http://localhost:${port}/`);
  else console.error(`Unable to start local dashboard: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Smart Sport dashboard: http://localhost:${port}/`);
  console.log('Open in desktop Chrome or Edge. Keep this window open; press Ctrl+C to stop.');
});
