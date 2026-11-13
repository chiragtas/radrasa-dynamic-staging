import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer } from '../lib/vision.js';
import { boot, makeWorld, SHOP, PRODUCT } from './helpers.mjs';

const CDN = 'https://cdn.shopify.com/s/files/1/0001/products';
const mystery = { id: 888, title: 'Aurora Piece No. 7', handle: 'aurora-7', type: '', tags: [], options: [], featured_image: `${CDN}/aurora.jpg`, images: [`${CDN}/aurora.jpg`], variants: [{ id: 8001, title: 'Default Title', options: ['Default Title'], available: true }] };
const GEM = { GEMINI_API_KEY: 'k', TRYON_ENGINE: 'gemini', VISION_CLASSIFY: '1' };

test('vision answers are parsed strictly: only a known category word counts, anything unclear is "none"', () => {
  assert.equal(parseAnswer('hat'), 'hat');
  assert.equal(parseAnswer(' Wrist. '), 'wrist');
  assert.equal(parseAnswer('none'), 'none');
  assert.equal(parseAnswer('It looks like a lovely hat that someone might wear on a sunny day'), 'none');
  assert.equal(parseAnswer(''), 'none');
  assert.equal(parseAnswer('rocket'), 'none');
});

function withVision(world, answer) {
  const orig = world.fetch;
  world.visionCalls = 0;
  world.fetch = async (u, i) => {
    if (String(u).includes(':generateContent')) {
      world.visionCalls++;
      world.visionBody = JSON.parse(i.body);
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return orig(u, i);
  };
}

test('vision: a product the word lists cannot place is recognised from its photo, once, and remembered', async () => {
  const world = makeWorld();
  world.products['aurora-7'] = mystery;
  withVision(world, 'hat');
  const t = await boot({ env: GEM, world });
  const get = () => t.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`);
  const a = await get();
  assert.equal(a.json.tryable, true);
  assert.equal(a.json.category.id, 'hat');
  assert.equal(a.json.category.by, 'photo');
  assert.equal(a.json.needs, 'face');
  assert.equal(world.visionCalls, 1);
  const parts = world.visionBody.contents[0].parts;
  assert.ok(parts.some((p) => p.inline_data), 'the product photo was sent');
  await get(); await get();
  assert.equal(world.visionCalls, 1, 'asked once, then remembered');
  // a refresh from the store (older than 10 minutes) keeps the remembered answer
  const rec = await t.store.getProduct(SHOP, 'aurora-7');
  rec.fetchedAt = 1;
  await t.store.putProducts(SHOP, [rec]);
  assert.equal((await get()).json.category.id, 'hat');
  assert.equal(world.visionCalls, 1);
  await t.close();
});

test('vision: "none" is remembered too; unclear answers never make a product tryable; it is off unless switched on', async () => {
  const w1 = makeWorld(); w1.products['aurora-7'] = mystery; withVision(w1, 'it could be a gift');
  const t1 = await boot({ env: GEM, world: w1 });
  assert.equal((await t1.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`)).json.tryable, false);
  await t1.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`);
  assert.equal(w1.visionCalls, 1);
  await t1.close();

  const w2 = makeWorld(); w2.products['aurora-7'] = mystery; withVision(w2, 'hat');
  const t2 = await boot({ env: { ...GEM, VISION_CLASSIFY: '0' }, world: w2 });
  assert.equal((await t2.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`)).json.tryable, false);
  assert.equal(w2.visionCalls, 0);
  await t2.close();

  const w3 = makeWorld(); withVision(w3, 'none');
  const t3 = await boot({ env: GEM, world: w3 });
  await t3.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(w3.visionCalls, 0, 'when the words already decide (a hat), the photo is never sent');
  assert.equal((await t3.call('GET', `/api/product?shop=${SHOP}&handle=hair-oil`)).json.tryable, false);
  assert.equal(w3.visionCalls, 1, 'only products the words cannot place are looked at');
  await t3.close();
});

test('vision: if the vision service fails, nothing is remembered and the next visit tries again', async () => {
  const world = makeWorld(); world.products['aurora-7'] = mystery; withVision(world, new Error('offline'));
  const t = await boot({ env: GEM, world });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`)).json.tryable, false);
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`)).json.tryable, false);
  assert.equal(world.visionCalls, 2);
  await t.close();
});
