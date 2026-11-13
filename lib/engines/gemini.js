// Google Gemini image model (Nano Banana). Accepts several images, so the shopper's photo and the product photo go together.
import { TryOnError } from '../errors.js';

function pickImage(json) {
  let image = null;
  const texts = [];
  for (const step of json.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) image = block;
      if (block.type === 'text' && block.text) texts.push(block.text);
    }
  }
  if (!image && json.output_image?.data) image = json.output_image;
  return { image, text: texts.join(' ').trim() };
}

export const gemini = {
  id: 'gemini',
  maxPersonSide: 1536, // the shopper's photo can be large; Gemini keeps far more detail than Cloudflare
  productSide: 1024,
  ready: (env) => Boolean(env.GEMINI_API_KEY),
  async generate({ env, fetch: f, prompt, person, product, signal }) {
    const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    const body = {
      model: env.GEMINI_MODEL || 'gemini-nano-banana-2.1',
      input: [
        { type: 'text', text: prompt },
        { type: 'image', mime_type: person.mime, data: person.data },
        { type: 'image', mime_type: product.mime, data: product.data },
      ],
      response_format: { type: 'image', image_size: env.GEMINI_IMAGE_SIZE || '1K' },
    };
    let res;
    try {
      res = await f(`${base}/v1beta/interactions`, { method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') throw new TryOnError('The preview took too long. Please try again.', 504);
      throw new TryOnError('We could not create your preview just now. Please try again.', 502);
    }
    const raw = await res.text();
    let json = {};
    try { json = JSON.parse(raw); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      console.error(`[gemini] ${res.status} ${json?.error?.message || raw.slice(0, 200)}`);
      if (res.status === 429) throw new TryOnError('Try-on is very busy right now. Please try again in a minute.', 429);
      if (res.status === 400) throw new TryOnError('We could not use this photo. Please try a clear, well-lit, front-facing photo.', 422);
      if (res.status === 401 || res.status === 403) throw new TryOnError('Try-on is temporarily unavailable. Please try again later.', 503); // key rejected: see server log
      throw new TryOnError('We could not create your preview just now. Please try again.', 502);
    }
    const { image, text } = pickImage(json);
    if (!image) { if (text) console.warn('[engine] no image:', String(text).slice(0, 300)); throw new TryOnError('No preview was made this time. Please try a clearer, front-facing photo.', 422); }
    return { mime: image.mime_type || 'image/png', data: image.data };
  },
};
