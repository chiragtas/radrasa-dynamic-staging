import crypto from 'node:crypto';

const sessionKey = (env) => String(env.PLATFORM_SESSION_SECRET || env.SHOPIFY_API_SECRET || '');
export const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString('base64url')}:${derived.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltText, hashText] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltText, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

export function makeSession(userId, env, now = Date.now()) {
  const key = sessionKey(env);
  if (!key) throw new Error('PLATFORM_SESSION_SECRET or SHOPIFY_API_SECRET must be configured.');
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: now + 12 * 60 * 60_000, nonce: crypto.randomBytes(16).toString('base64url') })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(token, env, now = Date.now()) {
  const key = sessionKey(env);
  const [payload, signature, extra] = String(token || '').split('.');
  if (!key || !payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > now && typeof data.sub === 'string' ? data.sub : null;
  } catch { return null; }
}
