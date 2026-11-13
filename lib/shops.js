// Input validation for values that come from the browser. Everything that reaches a URL goes through here.
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const HANDLE_RE = /^[\p{L}\p{N}_.-]{1,255}$/u;

/** "my-store.myshopify.com" or null. Only permanent Shopify domains are accepted, so the server can never be pointed at another host. */
export function normalizeShop(value) {
  const v = String(value || '').trim().toLowerCase();
  return SHOP_RE.test(v) ? v : null;
}

export function normalizeHandle(value) {
  const v = String(value || '').trim();
  return HANDLE_RE.test(v) && !v.includes('..') ? v : null;
}
