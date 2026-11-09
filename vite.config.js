// Dev-server settings: the page on port 5173, no build step to play. The .claude folder holds agent worktrees whose edits must not
// reload the watcher's page; logs and dist are not watched either.
// The seat portraits (assets/portraits/: index.json and one PNG per seat, written by npm run art:accept) are served as they are, by
// the dev server (npm run up) and by vite preview alike, under /assets/portraits/; a file that is not there is a plain 404, never
// the page's HTML, so the page carries on with the initials.
import {readFile} from 'node:fs/promises';
import {join, normalize, sep} from 'node:path';

const PORTRAITS = join(process.cwd(), 'assets', 'portraits');
const TYPES = {'.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg'};
function portraits() {
  const serve = async (req, res, next) => {
    const path = decodeURIComponent((req.url || '').split('?')[0]);
    if (!path.startsWith('/assets/portraits/')) return next();
    const file = normalize(join(PORTRAITS, path.slice('/assets/portraits/'.length)));
    const type = TYPES[(file.match(/\.\w+$/) || [''])[0].toLowerCase()];
    if (!file.startsWith(PORTRAITS + sep) || !type) {res.statusCode = 404; return res.end()}
    try {const b = await readFile(file); res.setHeader('content-type', type); res.setHeader('cache-control', 'no-cache'); res.end(b)}
    catch {res.statusCode = 404; res.end()}
  };
  return {name: 'clocktower-portraits', configureServer: s => {s.middlewares.use(serve)}, configurePreviewServer: s => {s.middlewares.use(serve)}};
}

export default {
  plugins: [portraits()],
  server: {port: 5173, strictPort: true, watch: {ignored: ['**/.claude/**', '**/dist/**', '**/logs/**', '**/node_modules/**', '**/assets/incoming/**']}},
};
