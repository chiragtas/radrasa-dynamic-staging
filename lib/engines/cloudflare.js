// Cloudflare Workers AI (FLUX.2). Multi-reference editing: input_image_0 is the person, input_image_1 the product.
// Cloudflare only accepts input photos smaller than 512x512, so both are sent at 480 px or less.
import { TryOnError } from '../errors.js';

const sniff = (b64) => (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png');

/** Output size with the photo's shape, in multiples of 16 (the model's requirement). Tries a few sizes just under `max` and keeps the one whose shape is closest, so nothing is stretched. */
export function outputSize(w, h, max = 768) {
  const ratio = w / h;
  const clamp = (v) => Math.min(1920, Math.max(256, v));
  let best = null;
  for (let step = 0; step <= 8; step++) {
    const long = clamp(Math.floor(max / 16) * 16 - step * 16);
    const width = ratio >= 1 ? long : clamp(Math.round((long * ratio) / 16) * 16);
    const height = ratio >= 1 ? clamp(Math.round(long / ratio / 16) * 16) : long;
    const err = Math.abs(width / height / ratio - 1);
    if (!best || err < best.err - 0.004) best = { width, height, err };
  }
  return { width: best.width, height: best.height };
}

export const cloudflare = {
  id: 'cloudflare',
  maxPersonSide: 480,
  productSide: 480,
  ready: (env) => Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN),
  async generate({ env, fetch: f, prompt, person, product, signal }) {
    const base = env.CF_BASE_URL || 'https://api.cloudflare.com';
    const model = env.CF_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
    const { width, height } = outputSize(person.width, person.height, Number(env.CF_OUTPUT_MAX || 768));
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('input_image_0', new Blob([Buffer.from(person.data, 'base64')], { type: person.mime }), 'person.jpg');
    form.append('input_image_1', new Blob([Buffer.from(product.data, 'base64')], { type: product.mime }), 'product.jpg');
    form.append('width', String(width));
    form.append('height', String(height));
    if (env.CF_GUIDANCE) form.append('guidance', env.CF_GUIDANCE);
    let res;
    try {
      res = await f(`${base}/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`, { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: form, signal });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') throw new TryOnError('The preview took too long. Please try again.', 504);
      throw new TryOnError('We could not create your preview just now. Please try again.', 502);
    }
    const raw = await res.text();
    let json = {};
    try { json = JSON.parse(raw); } catch { /* non-JSON error body */ }
    if (!res.ok || json.success === false) {
      const detail = json?.errors?.[0]?.message || raw.slice(0, 200);
      console.error(`[cloudflare] ${res.status} ${detail}`);
      if (res.status === 429 || /capacity|rate limit|neurons|quota/i.test(detail)) throw new TryOnError('Try-on is very busy right now. Please try again in a few minutes.', 429);
      if (res.status === 400 || res.status === 422) throw new TryOnError('We could not use this photo. Please try a clear, well-lit, front-facing photo.', 422);
      if (res.status === 401 || res.status === 403) throw new TryOnError('Try-on is temporarily unavailable. Please try again later.', 503); // token rejected: see server log
      throw new TryOnError('We could not create your preview just now. Please try again.', 502);
    }
    const b64 = json?.result?.image ?? json?.image;
    if (typeof b64 !== 'string' || !b64) throw new TryOnError('No preview was made this time. Please try a clearer, front-facing photo.', 422);
    return { mime: sniff(b64), data: b64 };
  },
};
