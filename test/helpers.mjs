import crypto from 'node:crypto';
import { createApp } from '../server.js';
import { createFileStore } from '../lib/store.js';

import sharp from 'sharp';

// Real, decodable test pictures (the server now inspects images): a person-like gradient, a clearly different "AI result", a product shot.
async function make(fn, w = 96, h = 128) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const i = (y * w + x) * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; }
  return (await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()).toString('base64');
}
export const JPEG = await make((x, y) => [x * 2, y * 2, 120 + ((x + y) % 40)]);          // the shopper's photo
export const OUT = await make((x, y) => [255 - x * 2, 40 + ((x * y) % 160), 255 - y * 2]); // what the "AI" returns
export const PRODUCT = await make((x, y) => (x > 30 && x < 66 && y > 40 && y < 90 ? [200, 30, 30] : [255, 255, 255]));

export const SHOP = 'cool-store.myshopify.com';
export const CDN = 'https://cdn.shopify.com/s/files/1/0001/products';

// Public storefront shape: /products/<handle>.js
export const hatPublic = {
  id: 111, title: 'Classic Wool Beanie', handle: 'classic-wool-beanie', type: 'Hats', tags: ['winter'],
  options: [{ name: 'Color', position: 1, values: ['Red', 'Blue'] }, { name: 'Size', position: 2, values: ['S', 'M'] }],
  featured_image: `//cdn.shopify.com/s/files/1/0001/products/red.jpg`,
  images: [`//cdn.shopify.com/s/files/1/0001/products/red.jpg`, `//cdn.shopify.com/s/files/1/0001/products/blue.jpg`],
  variants: [
    { id: 1001, title: 'Red / S', options: ['Red', 'S'], featured_image: { src: `${CDN}/red.jpg` }, available: true },
    { id: 1002, title: 'Blue / S', options: ['Blue', 'S'], featured_image: { src: `${CDN}/blue.jpg` }, available: true },
    { id: 1003, title: 'Blue / M', options: ['Blue', 'M'], featured_image: null, available: true },
  ],
};
export const wigPublic = {
  id: 222, title: 'Brazilian Kinky Straight Hair Bundles', handle: 'kinky-straight', type: '', tags: [],
  options: [{ name: 'Length', position: 1, values: ['10 inch', '22 inch'] }],
  featured_image: `${CDN}/wig.jpg`, images: [`${CDN}/wig.jpg`],
  variants: [{ id: 2001, title: '10 inch', options: ['10 inch'], featured_image: null, available: true }, { id: 2002, title: '22 inch', options: ['22 inch'], featured_image: null, available: true }],
};
export const earringsPublic = { id: 444, title: 'Gold Hoop Earrings', handle: 'gold-hoops', type: 'Jewellery', tags: ['earrings'], options: [], featured_image: `${CDN}/hoops.jpg`, images: [`${CDN}/hoops.jpg`], variants: [{ id: 4001, title: 'Default Title', options: ['Default Title'], available: true }] };
export const watchPublic = { id: 555, title: 'Steel Chronograph Watch', handle: 'steel-watch', type: 'Watches', tags: [], options: [], featured_image: `${CDN}/watch.jpg`, images: [`${CDN}/watch.jpg`], variants: [{ id: 5101, title: 'Default Title', options: ['Default Title'], available: true }] };
export const oilPublic = { id: 333, title: 'Hair Growth Oil', handle: 'hair-oil', type: 'Care', tags: [], options: [], featured_image: `${CDN}/oil.jpg`, images: [`${CDN}/oil.jpg`], variants: [{ id: 3001, title: 'Default Title', options: ['Default Title'], available: true }] };

/** A fake internet: Shopify storefront + Admin API + CDN + Cloudflare + Gemini. Every request is recorded. */
export function makeWorld({ down = false } = {}) {
  const calls = [];
  const products = { 'classic-wool-beanie': hatPublic, 'kinky-straight': wigPublic, 'hair-oil': oilPublic, 'gold-hoops': earringsPublic, 'steel-watch': watchPublic };
  const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const world = {
    calls, products, down,
    async fetch(url, init = {}) {
      const u = new URL(url);
      calls.push({ url: String(url), init });
      if (world.down && u.hostname.endsWith('.myshopify.com')) throw new Error('offline');
      if (u.hostname === 'cdn.shopify.com') return new Response(Buffer.from(PRODUCT, 'base64'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      if (u.hostname === 'api.cloudflare.com') {
        if (world.aiDelay) await new Promise((r) => setTimeout(r, world.aiDelay));
        if (world.aiFail) return json({ success: false, errors: [{ message: 'Cloudflare Workers AI: Authentication error (code 10000)' }] }, world.aiFail);
        world.cf = { url: String(url), form: init.body, auth: init.headers.Authorization };
        return json({ success: true, result: { image: world.aiSeq?.length ? world.aiSeq.shift() : world.aiOut || OUT } });
      }
      if (u.hostname === 'generativelanguage.googleapis.com') {
        world.gemini = JSON.parse(init.body);
        if (world.geminiReply) return json(...world.geminiReply);
        return json({ steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: world.aiOut || OUT }] }] });
      }
      if (u.pathname === '/admin/oauth/access_token') return json({ access_token: 'shpat_secret', scope: 'read_products' });
      if (u.pathname.startsWith('/admin/api/')) {
        if (init.headers['X-Shopify-Access-Token'] !== 'shpat_secret') return json({ errors: 'bad token' }, 401);
        const handle = u.searchParams.get('handle');
        if (handle) return json({ products: products[handle] ? [asAdmin(products[handle])] : [] });
        if (u.searchParams.get('page_info') === 'p2') return json({ products: [asAdmin(oilPublic)] });
        return json({ products: [asAdmin(hatPublic), asAdmin(wigPublic)] }, 200, { link: `<https://${u.hostname}/admin/api/2025-07/products.json?limit=250&page_info=p2>; rel="next"` });
      }
      if (world.redirects?.[u.hostname]) return new Response(null, { status: 301, headers: { location: world.redirects[u.hostname] + u.pathname + u.search } });
      const m = /^\/products\/(.+)\.js$/.exec(u.pathname);
      if (m) return products[decodeURIComponent(m[1])] ? json(products[decodeURIComponent(m[1])]) : json({ error: 'nf' }, 404);
      if (u.pathname === '/products.json') return json({ products: u.searchParams.get('page') === '1' ? Object.values(products).map(asAdmin) : [] });
      return json({ error: 'not found in fake world' }, 404);
    },
  };
  return world;
}

// Admin API shape: images are objects with variant_ids, variants use option1..3 and image_id
export function asAdmin(p) {
  return {
    id: p.id, title: p.title, handle: p.handle, product_type: p.type, tags: p.tags.join(', '),
    options: p.options.map((o) => ({ name: o.name })),
    images: p.images.map((src, i) => ({ id: 9000 + i, src: src.startsWith('//') ? `https:${src}` : src, variant_ids: p.variants.filter((v) => v.featured_image && String(v.featured_image.src || '').endsWith(src.split('/').pop())).map((v) => v.id) })),
    variants: p.variants.map((v) => ({ id: v.id, title: v.title, option1: v.options[0], option2: v.options[1] ?? null, option3: null })),
  };
}

export async function boot({ env = {}, world = makeWorld(), engine } = {}) {
  const store = createFileStore(null);
  const e = { OPEN_SHOPS: '1', ...env };
  const app = await createApp({ env: e, fetch: world.fetch, store, ...(engine !== undefined ? { engine } : {}) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json: j, text, headers: res.headers };
  };
  return { world, store, call, close: () => new Promise((r) => server.close(r)), base };
}

export const hmacB64 = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64');
export const queryHmac = (params, secret) => {
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
};
export const photo = (w = 360, h = 480) => ({ mime: 'image/jpeg', data: JPEG, width: w, height: h });

/** Just enough Liquid for the block: comments/schema removed, `if a != blank and a != 'x'` / else / endif, output tags. */
export function renderLiquid(liquid, vars = {}) {
  // Minimal Liquid: `if a != blank and a != 'x'` / else / endif, then output tags.
  const val = (k) => vars[k.trim()] ?? '';
  const truthy = (cond) => cond.split(/\s+and\s+/).every((c) => {
    const m = c.match(/^\s*([\w.]+)\s*!=\s*(blank|'[^']*')\s*$/);
    if (!m) throw new Error('unsupported liquid condition: ' + c);
    return m[2] === 'blank' ? String(val(m[1])).trim() !== '' : String(val(m[1])) !== m[2].slice(1, -1);
  });
  return liquid
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
    .replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/g, '')
    .replace(/\{%-?\s*if (.+?)\s*-?%\}([\s\S]*?)(?:\{%-?\s*else\s*-?%\}([\s\S]*?))?\{%-?\s*endif\s*-?%\}/g, (_m, cond, yes, no) => (truthy(cond) ? yes : no || ''))
    .replace(/\{%-?[\s\S]*?-?%\}/g, '')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
      const key = expr.split('|')[0].trim();
      const def = /\|\s*default:\s*(['"])([\s\S]*?)\1/.exec(expr);
      const v = vars[key];
      return v !== undefined && v !== '' ? v : def ? def[2] : '';
    });
}

