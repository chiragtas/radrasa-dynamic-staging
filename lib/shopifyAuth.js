// Shopify app plumbing: install (OAuth) flow, request signatures and token storage.
import crypto from 'node:crypto';

const hex = (buf) => buf.toString('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Verify the `hmac` that Shopify adds to install / app-load URLs. */
export function verifyQueryHmac(query, secret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac || !secret) return false;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  return safeEqual(hex(crypto.createHmac('sha256', secret).update(msg).digest()), String(hmac));
}

/** Verify the X-Shopify-Hmac-Sha256 header of a webhook against the raw request body. */
export function verifyWebhookHmac(rawBody, header, secret) {
  if (!header || !secret || !Buffer.isBuffer(rawBody)) return false;
  return safeEqual(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'), String(header));
}

/** Signed, expiring OAuth state. The same value is also kept in a cookie, so only the browser that began the install can finish it. */
export function makeState(shop, secret, now = Date.now(), ownerId = '') {
  const rand = crypto.randomBytes(12).toString('hex');
  const owner = ownerId ? Buffer.from(String(ownerId)).toString('base64url') : '';
  const sig = hex(crypto.createHmac('sha256', secret).update(`${shop}.${now}.${rand}.${owner}`).digest());
  return `${now}.${rand}.${owner}.${sig}`;
}
export function checkState(state, shop, secret, now = Date.now(), maxAgeMs = 10 * 60_000) {
  const parts = String(state || '').split('.');
  const [ts, rand] = parts;
  const owner = parts.length === 4 ? parts[2] : '';
  const sig = parts.length === 4 ? parts[3] : parts[2];
  if (!ts || !rand || !sig || !/^\d+$/.test(ts) || now - Number(ts) > maxAgeMs || now < Number(ts) - 60_000) return false;
  const signed = parts.length === 4 ? `${shop}.${ts}.${rand}.${owner}` : `${shop}.${ts}.${rand}`;
  return safeEqual(hex(crypto.createHmac('sha256', secret).update(signed).digest()), sig);
}
export function stateOwner(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4 || !parts[2]) return null;
  try { return Buffer.from(parts[2], 'base64url').toString('utf8') || null; } catch { return null; }
}

export function installUrl({ shop, apiKey, scopes, appUrl, state }) {
  const q = new URLSearchParams({ client_id: apiKey, scope: scopes, redirect_uri: `${appUrl.replace(/\/$/, '')}/auth/callback`, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

export async function exchangeCode({ fetch: f, shop, apiKey, secret, code }) {
  const res = await f(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: secret, code }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new Error('token exchange returned no token');
  return { token: json.access_token, scope: json.scope || '' };
}

// Access tokens are stored encrypted (AES-256-GCM). Key = TOKEN_ENC_KEY, or derived from the app secret if that is not set.
const key = (env) => crypto.createHash('sha256').update(String(env.TOKEN_ENC_KEY || env.SHOPIFY_API_SECRET || 'tryon-dev-key')).digest();
export function encryptToken(plain, env = process.env) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(env), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decryptToken(stored, env = process.env) {
  if (!stored) return null;
  if (!String(stored).startsWith('enc1:')) return String(stored);
  try {
    const [, iv, tag, ct] = String(stored).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
