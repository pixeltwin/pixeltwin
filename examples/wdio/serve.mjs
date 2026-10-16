// A static server for the demo site in ./site, with no dependencies.
//   node serve.mjs                      http://localhost:19182 (SITE_PORT to change it)
//   DEMO_CHANGE=1 node serve.mjs        the same site with site/demo-change.css switched on
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

/** Starts the site; resolves to the running server (call `close()` to stop it). */
export function startSite(port = Number(process.env.SITE_PORT ?? 19182), change = process.env.DEMO_CHANGE === '1') {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      // The change stylesheet is linked from every page and empty unless DEMO_CHANGE=1.
      const body = path === '/demo-change.css' && !change ? '' : await readFile(file);
      res.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`demo site on http://localhost:${port}${change ? ' (DEMO_CHANGE=1)' : ''}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startSite();
