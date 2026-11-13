// Optional: recognise what a product is from its PHOTO, for products whose name/type/tags the word lists cannot place.
// Switched on with VISION_CLASSIFY=1. Each product is looked at once; the answer (including "none") is saved with the product.
// Engine: Gemini if GEMINI_API_KEY is set, otherwise Cloudflare Workers AI (LLaVA). Override with VISION_ENGINE=gemini|cloudflare.
import { categoryIds } from './categories.js';

const QUESTION = (title) =>
  `This is a product photo of "${String(title || '').slice(0, 80).replace(/["\n]/g, ' ')}". ` +
  `Which ONE of these describes what a person would WEAR or APPLY: ${categoryIds().join(', ')}? ` +
  'hair = wigs, hair extensions, braids; wrist = watches and bracelets; headwear = headbands and hair clips. ' +
  'If it is not worn or applied on the body (a bottle, a box, furniture, a gift card, a tool), answer none. Answer with that one word only.';

export function parseAnswer(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
  const words = t.split(/\s+/).filter(Boolean);
  const ids = new Set(categoryIds());
  if (words.length && words.length <= 4) {
    for (const w of words) if (ids.has(w)) return w;
    if (words.includes('none')) return 'none';
  }
  return 'none'; // anything unclear counts as "not something to try on": we never guess
}

const GEMINI = async ({ env, fetch: f, image, title }) => {
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const model = env.VISION_MODEL || 'gemini-2.5-flash';
  const res = await f(`${base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: QUESTION(title) }, { inline_data: { mime_type: image.mime, data: image.data } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`gemini vision ${res.status}`);
  const j = await res.json();
  return j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(' ') || '';
};

const CLOUDFLARE = async ({ env, fetch: f, image, title }) => {
  const base = env.CF_BASE_URL || 'https://api.cloudflare.com';
  const model = env.VISION_MODEL || '@cf/llava-hf/llava-1.5-7b-hf';
  const res = await f(`${base}/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: QUESTION(title), image: Array.from(Buffer.from(image.data, 'base64')), max_tokens: 8 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`cloudflare vision ${res.status}`);
  const j = await res.json();
  return j?.result?.description || j?.result?.response || '';
};

export function visionEngine(env) {
  if (env.VISION_CLASSIFY !== '1') return null;
  const want = (env.VISION_ENGINE || '').toLowerCase();
  if ((want === 'gemini' || !want) && env.GEMINI_API_KEY) return GEMINI;
  if ((want === 'cloudflare' || !want) && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) return CLOUDFLARE;
  return null;
}

/** Returns a category id or 'none'. Throws if the service could not be reached (so the caller does not save a wrong "none"). */
export async function classifyByPhoto({ env, fetch: f, image, title }) {
  const run = visionEngine(env);
  if (!run) return null;
  return parseAnswer(await run({ env, fetch: f, image, title }));
}
