import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--port');
const port = arg === -1 ? 8787 : Number(process.argv[arg + 1]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const relative = decodeURIComponent(url.pathname === '/' ? '/demo/index.html' : url.pathname);
        if (!/^\/(?:demo\/[^/]+\.(?:html|js)|src\/[^/]+\.js|style\.css|manifest\.json)$/.test(relative)) { response.writeHead(403).end('Forbidden'); return; }
        const target = path.resolve(root, '.' + relative);
        if (!target.startsWith(root + path.sep)) { response.writeHead(403).end('Forbidden'); return; }
        const body = await readFile(target);
        response.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(body);
    } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log('共叙框架预览：http://127.0.0.1:' + port + '/demo/index.html'));
