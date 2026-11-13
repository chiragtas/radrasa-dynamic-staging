// Downloads a product photo for the AI. Only Shopify's own image hosts are allowed, so a store (or a shopper)
// cannot make this server fetch an arbitrary address.
import { TryOnError } from './errors.js';

const MAX_BYTES = 6 * 1024 * 1024;
const OK_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isAllowedImageUrl(raw, shop) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return u.hostname === 'cdn.shopify.com' || u.hostname === shop;
}

/** Fetch a product photo at (at most) `maxSide` px using Shopify's CDN resizing. */
export async function fetchProductImage({ fetch: f, url, shop, maxSide }) {
  const abs = url.startsWith('//') ? `https:${url}` : url;
  if (!isAllowedImageUrl(abs, shop)) throw new TryOnError('This product\'s photo is not hosted by Shopify, so it cannot be used.', 422);
  const u = new URL(abs);
  if (maxSide) u.searchParams.set('width', String(maxSide));
  let res;
  try {
    res = await f(u.toString(), { headers: { Accept: 'image/jpeg,image/png,image/webp' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new TryOnError('Could not load the product photo. Please try again.', 502);
  }
  if (!res.ok) throw new TryOnError('Could not load the product photo.', 502);
  const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!OK_TYPES.has(mime)) throw new TryOnError('The product photo is in a format we cannot use.', 422);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new TryOnError('The product photo is too large.', 422);
  return { mime, data: buf.toString('base64') };
}
