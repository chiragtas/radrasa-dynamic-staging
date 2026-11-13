// Getting a store's products: one product on demand (when a shopper opens a product page) or the whole catalogue (sync).
//  1. Public storefront endpoints need no login:  /products/<handle>.js  and  /products.json
//  2. If the store installed the app we also hold an Admin API token, which works for password-protected or unlisted stores.
// Every shape is converted to one normalized product:
//   { id, handle, title, type, tags[], options[names], images[urls], variants:[{ id, title, options[values], image|null, available }] }
import { TryOnError } from './errors.js';

export const API_VERSION = '2025-07';
const absUrl = (u) => (typeof u === 'string' && u ? (u.startsWith('//') ? `https:${u}` : u) : null);
const imgSrc = (i) => absUrl(typeof i === 'string' ? i : i?.src || i?.url);

export function normalizeProduct(raw) {
  if (!raw || !raw.handle) return null;
  const rawImages = raw.images || [];
  const images = rawImages.map(imgSrc).filter(Boolean);
  // Alt text (from images or from media) helps match a colour to its photo when a variant has no photo of its own.
  const alts = {};
  rawImages.forEach((i) => { if (i && typeof i === 'object' && i.alt) alts[imgSrc(i)] = String(i.alt); });
  (raw.media || []).forEach((m) => { if (m && m.alt && (m.src || m.preview_image?.src)) alts[imgSrc(m.src || m.preview_image.src)] = String(m.alt); });
  const imageById = new Map();
  const imageByVariant = new Map();
  rawImages.forEach((i) => {
    if (i && typeof i === 'object') {
      if (i.id != null) imageById.set(String(i.id), imgSrc(i));
      (i.variant_ids || []).forEach((v) => { if (!imageByVariant.has(String(v))) imageByVariant.set(String(v), imgSrc(i)); });
    }
  });
  const options = (raw.options || []).map((o) => (typeof o === 'string' ? o : o?.name)).filter(Boolean);
  const tags = Array.isArray(raw.tags) ? raw.tags : String(raw.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const variants = (raw.variants || []).map((v) => {
    const opts = Array.isArray(v.options) && v.options.length ? v.options : [v.option1, v.option2, v.option3].filter((x) => x != null && x !== '');
    const own = imgSrc(v.featured_image) || (v.image_id != null ? imageById.get(String(v.image_id)) : null) || imageByVariant.get(String(v.id)) || null;
    return { id: String(v.id), title: String(v.title || opts.join(' / ')), options: opts.map(String), image: own, available: v.available !== false };
  });
  const featured = imgSrc(raw.featured_image) || images[0] || null;
  return {
    id: String(raw.id),
    handle: String(raw.handle),
    title: String(raw.title || ''),
    type: String(raw.product_type ?? raw.type ?? ''),
    tags,
    options,
    images: featured && !images.includes(featured) ? [featured, ...images] : images,
    imageAlts: alts,
    variants,
    fetchedAt: Date.now(),
  };
}

const IP_HOST = /^(\[.*\]|\d{1,3}(\.\d{1,3}){3})$/;
const BAD_HOST = /(^|\.)(localhost|local|internal|localdomain)$/i;

/** A redirect we are willing to follow: https only, a real host name (no IP address, no local names), and the SAME path
 *  (a store sends /products/x.js to its own custom domain; nothing else is expected). */
function safeRedirect(from, location) {
  let to;
  try { to = new URL(location, from); } catch { return null; }
  if (to.protocol !== 'https:' || to.username || to.password || (to.port && to.port !== '443')) return null;
  if (IP_HOST.test(to.hostname) || BAD_HOST.test(to.hostname) || !to.hostname.includes('.')) return null;
  if (to.pathname !== from.pathname) return null;
  return to;
}

// Public pages only follow redirects (Shopify sends *.myshopify.com to the store's own domain). Requests that carry an access
// token never follow redirects, so the token cannot be sent to another host.
async function getJson(fetchFn, url, headers = {}) {
  const authed = Object.keys(headers).some((h) => /token|authorization/i.test(h));
  let current = new URL(url);
  let res;
  for (let hops = 0; ; hops++) {
    try {
      res = await fetchFn(current.toString(), { headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      console.error('[shopify-fetch]', current.hostname, current.pathname, e?.name || 'Error', e?.message || 'request failed');
      throw new TryOnError('Could not reach the store. Please try again.', 502);
    }
    if (res.status >= 300 && res.status < 400 && !authed) {
      const loc = res.headers.get('location') || '';
      if (/\/password(\b|$)/.test(loc)) throw new TryOnError('The store is password-protected, so its product pages cannot be read without the app connection. Open lookOn in the Shopify admin once.', 403);
      const next = hops < 3 ? safeRedirect(current, loc) : null;
      if (!next) throw new TryOnError('The store sent us somewhere we cannot follow. Please try again.', 502);
      current = next;
      continue;
    }
    break;
  }
  if (res.status === 404) throw new TryOnError('That product was not found in the store.', 404);
  if (!res.ok) throw new TryOnError(`The store returned an error (${res.status}).`, 502);
  try {
    return { json: await res.json(), res };
  } catch {
    throw new TryOnError('The store returned data we could not read.', 502);
  }
}

/** One product from the live store. Admin API first when we hold a token, else the public storefront. */
export async function fetchProduct({ fetch: f, shop, handle, token }) {
  if (token) {
    try {
      const { json } = await getJson(f, `https://${shop}/admin/api/${API_VERSION}/products.json?handle=${encodeURIComponent(handle)}&limit=1`, { 'X-Shopify-Access-Token': token });
      const p = normalizeProduct(json.products?.[0]);
      if (p) return p;
      // The store's own catalogue says there is no such product: the public page would not know better.
      throw new TryOnError('That product was not found in the store.', 404);
    } catch (e) {
      if (e.status === 404) throw e;
      console.warn('[products] admin fetch failed, trying public page:', e.message);
    }
  }
  const { json } = await getJson(f, `https://${shop}/products/${encodeURIComponent(handle)}.js`);
  const p = normalizeProduct(json);
  if (!p) throw new TryOnError('That product was not found in the store.', 404);
  return p;
}

/** Every product in the store (up to maxPages * 250). */
export async function fetchAllProducts({ fetch: f, shop, token, maxPages = 40 }) {
  const out = [];
  if (token) {
    let url = `https://${shop}/admin/api/${API_VERSION}/products.json?limit=250`;
    for (let i = 0; i < maxPages && url; i++) {
      const { json, res } = await getJson(f, url, { 'X-Shopify-Access-Token': token });
      (json.products || []).forEach((r) => { const p = normalizeProduct(r); if (p) out.push(p); });
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers?.get?.('link') || '');
      url = next ? next[1] : null;
    }
    return out;
  }
  for (let page = 1; page <= maxPages; page++) {
    const { json } = await getJson(f, `https://${shop}/products.json?limit=250&page=${page}`);
    const list = json.products || [];
    list.forEach((r) => { const p = normalizeProduct(r); if (p) out.push(p); });
    if (list.length < 250) break;
  }
  return out;
}

const wordsOf = (x) => ` ${String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Pick the variant the shopper selected (falls back to the first available one) and the photo that shows it:
 *  1) the variant's own photo,
 *  2) else the one product photo whose file name or alt text mentions the variant's options (e.g. "burgundy"),
 *  3) else the product's main photo.
 * `by` says which rule was used.
 */
export function pickVariant(product, variantId) {
  const variants = product.variants || [];
  const v = variants.find((x) => x.id === String(variantId)) || variants.find((x) => x.available) || variants[0] || null;
  if (v?.image) return { variant: v, image: v.image, exact: true, by: 'variant' };
  const terms = (v?.options || []).map((o) => wordsOf(o).trim()).filter((t) => t.length >= 3 && !/^\d+( \d+)*$/.test(t) && t !== 'default title');
  if (terms.length && product.images.length > 1) {
    const scored = product.images.map((src) => {
      const stem = decodeURIComponent(String(src).split('?')[0].split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
      const hay = wordsOf(`${stem} ${(product.imageAlts || {})[src] || ''}`);
      return { src, n: terms.filter((t) => hay.includes(` ${t} `)).length };
    });
    const top = Math.max(...scored.map((x) => x.n));
    const winners = scored.filter((x) => x.n === top);
    if (top > 0 && winners.length === 1) return { variant: v, image: winners[0].src, exact: true, by: 'match' };
  }
  return { variant: v, image: product.images[0] || null, exact: false, by: 'default' };
}
