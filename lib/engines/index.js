// Pick the AI engine with TRYON_ENGINE=gemini | cloudflare | mock. Unset = the first one whose credentials exist.
import { gemini } from './gemini.js';
import { cloudflare } from './cloudflare.js';

const mock = {
  id: 'mock',
  maxPersonSide: 1024,
  productSide: 512,
  ready: () => true,
  async generate({ person }) { return { mime: person.mime, data: person.data }; }, // echoes the photo, for testing without AI
};

export function pickEngine(env = process.env) {
  const want = (env.TRYON_ENGINE || '').toLowerCase();
  const all = { gemini, cloudflare, mock };
  if (want) return all[want] && all[want].ready(env) ? all[want] : null;
  return [gemini, cloudflare].find((e) => e.ready(env)) || null;
}
