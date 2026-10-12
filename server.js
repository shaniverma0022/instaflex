// InstaFlex server. No dependencies, needs Node 18+.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Readable } = require('stream');
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.IG_ACCESS_TOKEN || '';          // stays on the server only
const GRAPH = 'https://graph.instagram.com/v21.0';
const CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;      // only fetch from Instagram's own CDN
const store = new Map(), hits = new Map();

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function shortcode(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !/^(www\.)?instagram\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/i);
  return m ? m[1] : null;
}

// Official Instagram API: finds a video among the media of the connected account.
async function findOwnMedia(code) {
  let url = `${GRAPH}/me/media?fields=id,media_type,media_url,thumbnail_url,permalink,caption&limit=100&access_token=${TOKEN}`;
  for (let i = 0; i < 5 && url; i++) {
    const d = await (await fetch(url)).json();
    if (d.error) throw new Error('Instagram API: ' + d.error.message);
    const hit = (d.data || []).find(m => m.permalink && m.permalink.includes(`/${code}/`));
    if (hit) return hit;
    url = d.paging && d.paging.next;
  }
  return null;
}

async function readBody(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 10000) break; }
  try { return JSON.parse(s); } catch { return {}; }
}

async function resolve(req, res) {
  const ip = req.socket.remoteAddress, now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 15) return json(res, 429, { error: 'Too many requests. Please wait a minute and try again.' });
  hits.set(ip, [...recent, now]);

  const code = shortcode((await readBody(req)).url);
  if (!code) return json(res, 400, { error: "That isn't a valid Instagram Reel or video link." });
  if (!TOKEN) return json(res, 501, { error: 'The site owner has not connected an Instagram account yet (IG_ACCESS_TOKEN is missing).' });

  const m = await findOwnMedia(code);
  if (!m) return json(res, 404, { error: "This video isn't in the connected Instagram account. Instagram's official API only provides files for media owned by the connected account." });
  if (m.media_type !== 'VIDEO' || !m.media_url) return json(res, 422, { error: 'This post has no downloadable video.' });

  const id = crypto.randomUUID(), name = `instaflex-${code}.mp4`;
  store.set(id, { src: m.media_url, name, exp: now + 15 * 60000 });
  json(res, 200, {
    id, name, thumb: m.thumbnail_url || '', caption: (m.caption || '').slice(0, 140),
    note: "Instagram's official API provides one file per video: the original upload. Both buttons download that same untouched file, so HD is only as high as the original quality."
  });
}

// Streams the original file straight from Instagram's CDN: no re-encoding, no overlays.
async function file(req, res, u) {
  const e = store.get(u.searchParams.get('id'));
  if (!e || e.exp < Date.now()) return json(res, 410, { error: 'This link expired. Press Get Video again.' });
  const src = new URL(e.src);
  if (!CDN.test(src.hostname)) return json(res, 400, { error: 'Blocked source.' });
  const up = await fetch(src, { headers: req.headers.range ? { Range: req.headers.range } : {} });
  if (!up.ok) return json(res, 502, { error: `Instagram's server answered with status ${up.status}.` });
  const out = {
    'Content-Type': up.headers.get('content-type') || 'video/mp4', 'Accept-Ranges': 'bytes',
    'Content-Disposition': `${u.searchParams.get('dl') ? 'attachment' : 'inline'}; filename="${e.name}"`
  };
  for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) out[k] = up.headers.get(k);
  res.writeHead(up.status, out);
  if (req.method === 'HEAD') return res.end();
  const stream = Readable.fromWeb(up.body); res.on('close', () => stream.destroy()); stream.pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && u.pathname === '/api/resolve') return await resolve(req, res);
    if (u.pathname === '/api/file' && ['GET', 'HEAD'].includes(req.method)) return await file(req, res, u);
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) json(res, 500, { error: err.message.startsWith('Instagram API') ? err.message : 'Something went wrong on the server.' }); else res.destroy();
  }
}).listen(PORT, () => console.log(`InstaFlex running at http://localhost:${PORT}`));
setInterval(() => { const n = Date.now(); for (const [k, v] of store) if (v.exp < n) store.delete(k); }, 300000).unref();
