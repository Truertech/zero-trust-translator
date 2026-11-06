// A tiny static file server for `tests/fixtures/`, started by Playwright's
// `webServer` for this repository's own extension tests. No framework: this
// repository approves no new runtime dependency, and a handful of static
// files need nothing more than `node:http`.
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tests', 'fixtures');
const PORT = Number(process.env['PORT'] ?? '4321');

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer((req, res) => {
  const requestPath = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname));
  const filePath = join(ROOT, requestPath === '/' ? 'page.html' : requestPath);
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
