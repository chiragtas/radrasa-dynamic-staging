import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, SHOP } from './helpers.mjs';

const ENV = { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
const q = (t) => t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie&variant=1001`);

test('product page: out of credits (message or hidden), then topped up, shows again at once', async () => {
  const t = await boot({ env: ENV });
  await t.store.putShop(SHOP, { status: 'installed', credits: { balance: 0, purchased: 0, spent: 0 }, creditUnit: 'credit', widget: { zeroCreditMode: 'message' } });
  let r = await q(t);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual([r.json.tryable, r.json.outOfCredits, r.json.category?.id], [false, true, 'hat'], 'message mode: the block shows with a note');
  await t.store.putShop(SHOP, { ...(await t.store.getShop(SHOP)), widget: { zeroCreditMode: 'hide' } });
  r = await q(t);
  assert.equal(r.json.category, null, 'hide mode: the block hides');
  await t.store.adjustCredits(SHOP, 500000, { type: 'topup' });
  // a stale copy of the store (read before the top-up, without creditUnit) must not touch the balance
  const { creditUnit: _u, ...stale } = await t.store.getShop(SHOP);
  await t.store.putShop(SHOP, { ...stale, credits: { balance: 0 } });
  r = await q(t);
  assert.deepEqual([r.json.tryable, r.json.outOfCredits, r.json.category?.id], [true, false, 'hat']);
  assert.equal((await t.store.getShop(SHOP)).credits.balance, 500000);
  await t.close();
});

test('product lookup: missing product is a plain 404; a password-protected storefront says so', async () => {
  const { fetchProduct } = await import('../lib/products.js');
  const admin = async (url) => (url.includes('/admin/') ? new Response(JSON.stringify({ products: [] }), { status: 200 }) : new Response('', { status: 302, headers: { location: 'https://x.myshopify.com/password' } }));
  await assert.rejects(fetchProduct({ fetch: admin, shop: 'x.myshopify.com', handle: 'nope', token: 't' }), (e) => e.status === 404);
  await assert.rejects(fetchProduct({ fetch: admin, shop: 'x.myshopify.com', handle: 'nope' }), (e) => e.status === 403 && /password-protected/.test(e.message));
});
