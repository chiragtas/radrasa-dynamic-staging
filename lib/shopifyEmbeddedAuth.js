import crypto from 'node:crypto';

const b64 = (value) => Buffer.from(value).toString('base64url');
const unb64 = (value) => Buffer.from(value, 'base64url');

export function verifyShopifyIdToken(token, env = process.env) {
  const secret = String(env.SHOPIFY_API_SECRET || '');
  const clientId = String(env.SHOPIFY_API_KEY || '');
  const [head, body, signature, extra] = String(token || '').split('.');
  if (!secret || !clientId || extra || !head || !body || !signature) throw new Error('Missing Shopify ID token.');
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const actual = unb64(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Invalid Shopify ID token signature.');
  let payload;
  try { payload = JSON.parse(unb64(body).toString('utf8')); } catch { throw new Error('Invalid Shopify ID token payload.'); }
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId || !payload.dest || !payload.sub || Number(payload.exp) <= now || Number(payload.nbf || 0) > now) throw new Error('Invalid or expired Shopify ID token.');
  const shop = new URL(payload.dest).hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid Shopify store in ID token.');
  return { ...payload, shop };
}

export async function exchangeShopifyIdToken({ fetch: fetchFn = globalThis.fetch, token, shop, env = process.env }) {
  const response = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: String(env.SHOPIFY_API_KEY || ''),
      client_secret: String(env.SHOPIFY_API_SECRET || ''),
      subject_token: token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      // Shopify's token-exchange namespace is `urn:shopify`, not the
      // generic OAuth token-type namespace. The latter causes a 400.
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    // Keep credentials and the ID token out of logs, but retain Shopify's
    // diagnostic code so a failed deployment can be diagnosed from Vercel.
    console.error('[shopify-token-exchange]', shop, response.status, data.error || 'unknown', data.error_description || '');
    throw new Error(`Shopify token exchange failed (${response.status}).`);
  }
  return { token: data.access_token, scope: data.scope || '' };
}
