import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareProduct, fitAspect, assess } from '../lib/imageops.js';
import { outputSize } from '../lib/engines/cloudflare.js';
import { buildPrompt } from '../lib/prompt.js';
import { boot, makeWorld, JPEG, OUT, SHOP, photo } from './helpers.mjs';

const solid = async (w, h, bg, comp) => (await sharp({ create: { width: w, height: h, channels: 3, background: bg } }).composite(comp || []).jpeg().toBuffer()).toString('base64');
const meta = async (img) => sharp(Buffer.from(img.data, 'base64')).metadata();

test('product photo: plain borders are removed and the item is centred on a square', async () => {
  const red = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#c82020' } }).png().toBuffer();
  const data = await solid(600, 300, '#ffffff', [{ input: red, left: 100, top: 130 }]); // small item on a wide white photo
  const out = await prepareProduct({ mime: 'image/jpeg', data }, 480);
  const m = await meta(out);
  assert.equal(m.width, 480);
  assert.equal(m.height, 480);
  // the item now fills most of the frame instead of a tiny part of it
  const { data: px } = await sharp(Buffer.from(out.data, 'base64')).raw().toBuffer({ resolveWithObject: true });
  let nonWhite = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] < 200 || px[i + 1] < 200) nonWhite++;
  assert.ok(nonWhite / (480 * 480) > 0.35, `item fills ${(nonWhite / 480 / 480).toFixed(2)} of the frame`);
  const broken = await prepareProduct({ mime: 'image/jpeg', data: 'AAAA' }, 480);
  assert.equal(broken.data, 'AAAA', 'unreadable photos pass through untouched');
});

test('output shape: a result a hair off the photo\'s shape is trimmed to match; big differences are left alone', async () => {
  const slightly = { mime: 'image/jpeg', data: await solid(544, 768, '#888') }; // 0.708 vs 0.75 wanted
  const fixed = await meta(await fitAspect(slightly, 360, 480));
  assert.ok(Math.abs(fixed.width / fixed.height - 0.75) < 0.003, `${fixed.width}x${fixed.height}`);
  const wide = { mime: 'image/jpeg', data: await solid(768, 768, '#888') };
  const same = await meta(await fitAspect(wide, 360, 480));
  assert.equal(same.width, 768);
  assert.equal(same.height, 768);
});

test('output size for the Cloudflare model keeps the photo\'s shape as closely as multiples of 16 allow', () => {
  assert.deepEqual(outputSize(360, 480), { width: 576, height: 768 });
  assert.deepEqual(outputSize(480, 270), { width: 768, height: 432 });
  for (const [w, h] of [[337, 480], [480, 421], [300, 480], [480, 479], [271, 480]]) {
    const s = outputSize(w, h);
    assert.ok(s.width % 16 === 0 && s.height % 16 === 0 && Math.max(s.width, s.height) <= 768);
    assert.ok(Math.abs(s.width / s.height / (w / h) - 1) < 0.02, `${w}x${h} -> ${s.width}x${s.height}`);
  }
});

test('result checks: blank and unchanged pictures are caught, small items are judged on local change', async () => {
  const person = { mime: 'image/jpeg', data: JPEG };
  const different = { mime: 'image/jpeg', data: OUT };
  const blank = { mime: 'image/jpeg', data: await solid(96, 128, '#777') };
  assert.deepEqual(await assess(blank, person, 'hat'), { ok: false, reason: 'blank' });
  assert.deepEqual(await assess(person, person, 'hat'), { ok: false, reason: 'unchanged' });
  assert.deepEqual(await assess(person, person, 'hair'), { ok: false, reason: 'unchanged' });
  // small items change only a patch: judged on whether ANY part changed
  assert.deepEqual(await assess(person, person, 'earrings'), { ok: false, reason: 'unchanged' });
  assert.deepEqual(await assess(person, person, 'wrist'), { ok: false, reason: 'unchanged' });
  const patch = await sharp({ create: { width: 14, height: 28, channels: 3, background: '#ffd700' } }).png().toBuffer();
  const withEarring = { mime: 'image/jpeg', data: (await sharp(Buffer.from(JPEG, 'base64')).composite([{ input: patch, left: 8, top: 60 }]).jpeg().toBuffer()).toString('base64') };
  assert.equal((await assess(withEarring, person, 'earrings')).ok, true, 'a small added item counts as a change');
  assert.equal((await assess(person, person, 'makeup')).ok, true, 'makeup is only checked for blank results');
  assert.equal((await assess(different, person, 'hat')).ok, true);
  assert.equal((await assess({ mime: 'image/png', data: 'AAAA' }, person, 'hat')).ok, true, 'unreadable output is not judged');
});

test('prompt: guards against copying the model in the product photo and against distortion', () => {
  const t = buildPrompt({ categoryId: 'hat', product: { title: 'Hat' }, variant: null });
  assert.match(t, /Never copy that person's face/);
  assert.match(t, /do not stretch, squash, widen or warp/);
  assert.match(t, /true size/);
});

const CF = { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', RATE_PER_MINUTE: '50' };
const body = { shop: SHOP, handle: 'classic-wool-beanie', variantId: '1002', image: photo(), consent: true };

test('flow: an unchanged result is retried once and the good second result is returned', async () => {
  const world = makeWorld();
  world.aiSeq = [JPEG, OUT]; // first the photo handed back unchanged, then a real result
  const t = await boot({ env: CF, world });
  const r = await t.call('POST', '/api/tryon', body);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.tries, 2);
  assert.equal(world.calls.filter((c) => c.url.includes('api.cloudflare.com')).length, 2);
  await t.close();
});

test('flow: if every try is unusable the shopper gets a clear message, not a bad picture', async () => {
  const world = makeWorld();
  world.aiOut = JPEG; // the AI keeps handing the photo back
  const t = await boot({ env: CF, world });
  const r = await t.call('POST', '/api/tryon', body);
  assert.equal(r.status, 422);
  assert.match(r.json.error, /did not come out right/);
  assert.equal(world.calls.filter((c) => c.url.includes('api.cloudflare.com')).length, 2, 'one try plus one retry');
  await t.close();
  const w2 = makeWorld();
  w2.aiOut = JPEG;
  const off = await boot({ env: { ...CF, TRYON_RETRIES: '0' }, world: w2 });
  assert.equal((await off.call('POST', '/api/tryon', body)).status, 422);
  assert.equal(w2.calls.filter((c) => c.url.includes('api.cloudflare.com')).length, 1);
  await off.close();
});
