import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeWorld, photo, hmacB64, queryHmac, SHOP, JPEG, OUT, hatPublic } from './helpers.mjs';
import { decryptToken } from '../lib/shopifyAuth.js';
import { normalizeProduct } from '../lib/products.js';

const CF = { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' };
const body = (extra = {}) => ({ shop: SHOP, handle: 'classic-wool-beanie', variantId: '1002', image: photo(), consent: true, ...extra });

test('product page lookup: category, variant and engine are detected automatically', async () => {
  const t = await boot({ env: CF });
  const r = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie&variant=1002`);
  assert.equal(r.status, 200);
  assert.equal(r.json.tryable, true);
  assert.equal(r.json.category.id, 'hat');
  assert.equal(r.json.variant.title, 'Blue / S');
  assert.equal(r.json.variant.ownImage, true);
  assert.equal(r.json.maxPersonSide, 480);
  const oil = await t.call('GET', `/api/product?shop=${SHOP}&handle=hair-oil`);
  assert.equal(oil.json.tryable, false);
  assert.equal((await t.call('GET', `/api/product?shop=evil.com&handle=x`)).status, 400);
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=missing-thing`)).status, 404);
  await t.close();
});

test('Cloudflare engine: sends the shopper photo AND the selected variant photo, with the variant in the prompt', async () => {
  const t = await boot({ env: CF });
  const r = await t.call('POST', '/api/tryon', body());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.category, 'hat');
  assert.equal(r.json.image.mime, 'image/jpeg');
  assert.ok(r.json.image.data.length > 100);
  const { form, url, auth } = t.world.cf;
  assert.match(url, /flux-2-klein-4b$/);
  assert.equal(auth, 'Bearer tok');
  assert.ok(form.get('input_image_0') && form.get('input_image_1'), 'person + product reference');
  assert.equal(form.get('width'), '576');
  assert.equal(form.get('height'), '768');
  const prompt = form.get('prompt');
  assert.match(prompt, /Classic Wool Beanie/);
  assert.match(prompt, /Color: Blue/);
  assert.match(prompt, /wearing this hat or cap/);
  const img = t.world.calls.filter((c) => c.url.startsWith('https://cdn.shopify.com')).map((c) => c.url);
  assert.equal(img.length, 1);
  assert.match(img[0], /blue\.jpg\?width=480$/, 'the blue variant photo was used, resized for Cloudflare');
  await t.close();
});

test('changing the variant changes the reference photo; a variant without its own photo gets the photo named after its colour, and keeps its options in the prompt', async () => {
  const t = await boot({ env: CF, });
  await t.call('POST', '/api/tryon', body({ variantId: '1001' }));
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /red\.jpg/);
  await t.call('POST', '/api/tryon', body({ variantId: '1003' }));
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /blue\.jpg/, 'no own photo, but the blue photo is found by name');
  assert.match(t.world.cf.form.get('prompt'), /Color: Blue, Size: M/);
  await t.close();
});

test('Gemini engine: both images in one request at the larger size', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'gemini', GEMINI_API_KEY: 'k' } });
  const cfg = await t.call('GET', '/api/config');
  assert.equal(cfg.json.engine, undefined, 'the AI provider is never named to shoppers');
  assert.equal(cfg.json.ready, true);
  assert.equal(cfg.json.maxPersonSide, 1536);
  const r = await t.call('POST', '/api/tryon', body({ image: photo(1200, 1600).width ? { ...photo(), width: 1152, height: 1536 } : null, handle: 'kinky-straight', variantId: '2002' }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.category, 'hair');
  const images = t.world.gemini.input.filter((x) => x.type === 'image');
  assert.equal(images.length, 2);
  const text = t.world.gemini.input.find((x) => x.type === 'text').text;
  assert.match(text, /22 inches/);
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /wig\.jpg\?width=1024$/);
  await t.close();
});

test('engine is chosen by setting; nothing configured means the block can hide itself', async () => {
  const none = await boot({ env: {} });
  assert.equal((await none.call('GET', '/api/config')).json.ready, false);
  const p = await none.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(p.json.tryable, false);
  assert.equal((await none.call('POST', '/api/tryon', body())).status, 503);
  await none.close();
  const both = await boot({ env: { GEMINI_API_KEY: 'k', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', TRYON_ENGINE: 'cloudflare' } });
  assert.equal((await both.call('GET', '/api/config')).json.engine, undefined);
  assert.equal((await both.call('POST', '/api/tryon', body())).status, 200);
  assert.ok(both.world.cf && !both.world.gemini, 'TRYON_ENGINE picks the engine');
  await both.close();
});

test('shoppers never learn which AI service makes the preview', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'gemini', GEMINI_API_KEY: 'k', RATE_PER_MINUTE: '50' } });
  const leak = (r) => /gemini|google|key|model|token|nano/i.test(r.text);
  // the provider's own refusal text is not passed on
  t.world.geminiReply = [{ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'As a Gemini model I cannot edit photos of people.' }] }] }];
  const refused = await t.call('POST', '/api/tryon', body({ handle: 'kinky-straight', variantId: '2002' }));
  assert.equal(refused.status, 422);
  assert.ok(!leak(refused), refused.text);
  // a rejected key reads as "temporarily unavailable"
  t.world.geminiReply = [{ error: { message: 'API key not valid. Please pass a valid API key.' } }, 403];
  const denied = await t.call('POST', '/api/tryon', body({ handle: 'kinky-straight', variantId: '2002' }));
  assert.equal(denied.status, 503);
  assert.equal(denied.json.code, 'unavailable');
  assert.ok(!leak(denied), denied.text);
  t.world.geminiReply = [{ error: { message: 'Resource has been exhausted (e.g. check quota).' } }, 429];
  const busy = await t.call('POST', '/api/tryon', body({ handle: 'kinky-straight', variantId: '2002' }));
  assert.equal(busy.json.code, 'busy');
  assert.ok(!leak(busy), busy.text);
  // the picture itself carries no maker or provenance tags
  t.world.geminiReply = null;
  const ok = await t.call('POST', '/api/tryon', body({ handle: 'kinky-straight', variantId: '2002' }));
  assert.equal(ok.status, 200, ok.text);
  const bytes = Buffer.from(ok.json.image.data, 'base64').toString('latin1');
  assert.ok(!/Exif|xmp|c2pa|jumb|Google|Gemini/i.test(bytes), 'metadata stripped');
  assert.ok(!leak(await t.call('GET', `/api/product?shop=${SHOP}&handle=kinky-straight`)));
  assert.equal(ok.headers.get('x-powered-by'), null, 'no server software header');
  await t.close();
});

test('metadata stripping works without the image library too', async () => {
  const { stripPng, stripJpeg } = await import('../lib/imageops.js');
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Software\0Google Gemini')), chunk('caBX', Buffer.from('c2pa manifest')), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
  const clean = stripPng(png).toString('latin1');
  assert.ok(!/Gemini|c2pa/.test(clean));
  assert.ok(clean.includes('IDAT') && clean.includes('IEND'));
  const seg = (m, s) => { const d = Buffer.from(s); const b = Buffer.alloc(4 + d.length); b[0] = 0xff; b[1] = m; b.writeUInt16BE(d.length + 2, 2); d.copy(b, 4); return b; };
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0'), seg(0xe1, 'Exif\0\0Google'), seg(0xeb, 'JUMBF c2pa'), Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
  const j = stripJpeg(jpg).toString('latin1');
  assert.ok(!/Google|c2pa/.test(j) && j.includes('JFIF'));
});

test('requests that must be refused', async () => {
  const t = await boot({ env: { ...CF, RATE_PER_MINUTE: '2' } });
  const post = (b) => t.call('POST', '/api/tryon', b);
  assert.equal((await post(body({ consent: false }))).status, 400);
  assert.equal((await post(body({ shop: 'evil.com' }))).status, 400);
  assert.equal((await post(body({ handle: '../x' }))).status, 400);
  assert.equal((await post(body({ image: { ...photo(), width: 4000, height: 3000 } }))).status, 400);
  assert.equal((await post(body({ image: { mime: 'image/gif', data: JPEG, width: 100, height: 100 } }))).status, 400);
  assert.equal((await post(body({ image: { ...photo(), data: '<script>' } }))).status, 400);
  assert.equal((await post(body({ handle: 'hair-oil' }))).status, 422);
  assert.equal(t.world.calls.some((c) => c.url.includes('cloudflare')), false, 'no AI call was made for refused requests');
  assert.equal((await post(body())).status, 200);
  assert.equal((await post(body())).status, 200);
  assert.equal((await post(body())).status, 429, 'per-visitor limit');
  await t.close();
});

test('per-store daily cap protects one store from using the whole budget', async () => {
  const t = await boot({ env: { ...CF, DAILY_CAP_PER_SHOP: '1', RATE_PER_MINUTE: '50' } });
  assert.equal((await t.call('POST', '/api/tryon', body())).status, 200);
  const r = await t.call('POST', '/api/tryon', body());
  assert.equal(r.status, 429);
  assert.match(r.json.error, /store/);
  await t.close();
});

test('store-specific product controls and credits are enforced', async () => {
  const t = await boot({ env: { ...CF, DAILY_CAP_PER_SHOP: '50', RATE_PER_MINUTE: '50' } });
  await t.store.putShop(SHOP, { status: 'installed', disabledProductHandles: ['classic-wool-beanie'] });
  await t.store.putProducts(SHOP, [normalizeProduct(hatPublic)]);
  const disabled = await t.call('POST', '/api/tryon', body());
  assert.equal(disabled.status, 403);
  assert.match(disabled.json.error, /disabled/i);
  const record = await t.store.getShop(SHOP);
  record.disabledProductHandles = [];
  await t.store.putShop(SHOP, record);
  // a new store starts at 0 credit: no AI call is made
  const cfBefore = t.world.calls.filter((c) => c.url.includes('cloudflare')).length;
  const empty = await t.call('POST', '/api/tryon', body());
  assert.equal(empty.status, 402);
  assert.equal(t.world.calls.filter((c) => c.url.includes('cloudflare')).length, cfBefore, 'no AI call without credit');
  // one image = 10 credits
  await t.store.adjustCredits(SHOP, 10000, { type: 'adjustment' });
  assert.equal((await t.call('POST', '/api/tryon', body())).status, 200);
  assert.equal((await t.store.getShop(SHOP)).credits.balance, 0);
  const ledger = await t.store.listLedger(SHOP);
  assert.equal(ledger[0].type, 'tryon');
  assert.equal(ledger[0].amount, -10000);
  const exhausted = await t.call('POST', '/api/tryon', body());
  assert.equal(exhausted.status, 402);
  const info = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(info.json.outOfCredits, true);
  assert.equal(info.json.tryable, false);
  assert.equal(info.json.category.id, 'hat', 'default: the block stays and shows the out-of-credit message');
  await t.store.putShop(SHOP, { ...(await t.store.getShop(SHOP)), widget: { zeroCreditMode: 'hide' } });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).json.category, null, 'hide mode hides the block');
  await t.close();
});

test('a product photo hosted somewhere else is refused (no server-side fetch of arbitrary URLs)', async () => {
  const world = makeWorld();
  world.products['evil-hat'] = { id: 5, title: 'Evil Hat', handle: 'evil-hat', type: 'Hats', tags: [], options: [], featured_image: 'https://169.254.169.254/latest/meta-data', images: ['https://169.254.169.254/latest/meta-data'], variants: [{ id: 5001, title: 'Default Title', options: ['Default Title'], available: true }] };
  const t = await boot({ env: CF, world });
  const r = await t.call('POST', '/api/tryon', body({ handle: 'evil-hat', variantId: '5001' }));
  assert.equal(r.status, 422);
  assert.equal(world.calls.some((c) => c.url.includes('169.254')), false);
  await t.close();
});

test('if the store is briefly unreachable, a recently seen product still works', async () => {
  const world = makeWorld();
  const t = await boot({ env: CF, world });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).status, 200);
  const rec = await t.store.getProduct(SHOP, 'classic-wool-beanie');
  rec.fetchedAt = Date.now() - 3_600_000; // old enough to need a refresh
  await t.store.putProducts(SHOP, [rec]);
  world.down = true;
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).status, 200);
  await t.close();
});

// ---------------- Shopify app: install, webhooks, sync ----------------
const APP = { ...CF, SHOPIFY_API_KEY: 'key', SHOPIFY_API_SECRET: 'sec', APP_URL: 'https://tryon.example.com', ADMIN_SECRET: 'adm', OPEN_SHOPS: '0' };

test('with the Shopify app configured, only installed stores can use the service', async () => {
  const t = await boot({ env: APP });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).status, 403);
  assert.equal((await t.call('POST', '/api/tryon', body())).status, 403);
  await t.store.putShop(SHOP, { installedAt: 1 });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).status, 200);
  await t.close();
});

test('install flow: signed start, state cookie, token exchange, encrypted token, catalogue synced', async () => {
  const t = await boot({ env: APP });
  const q = { shop: SHOP, timestamp: '1700000000' };
  const start = await t.call('GET', `/?${new URLSearchParams({ ...q, hmac: queryHmac(q, 'sec') })}`);
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location'), /^\/auth\?shop=/);
  assert.equal((await t.call('GET', `/?${new URLSearchParams({ ...q, hmac: 'bad' })}`)).headers.get('location'), null);

  const auth = await t.call('GET', `/auth?shop=${SHOP}`);
  assert.equal(auth.status, 302);
  const loc = new URL(auth.headers.get('location'));
  assert.equal(loc.hostname, SHOP);
  assert.equal(loc.searchParams.get('client_id'), 'key');
  assert.equal(loc.searchParams.get('scope'), 'read_products');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://tryon.example.com/auth/callback');
  const state = loc.searchParams.get('state');
  const cookie = `tryon_state=${state}`;
  assert.equal((await t.call('GET', `/auth?shop=evil.com`)).status, 400);

  const cb = { shop: SHOP, code: 'thecode', state, timestamp: '1700000000' };
  const good = `/auth/callback?${new URLSearchParams({ ...cb, hmac: queryHmac(cb, 'sec') })}`;
  assert.equal((await t.call('GET', good)).status, 400, 'no cookie');
  assert.equal((await t.call('GET', good.replace('thecode', 'x'), null, { cookie })).status, 400, 'tampered query');
  const ok = await t.call('GET', good, null, { cookie });
  assert.equal(ok.status, 302, ok.text);
  assert.match(ok.headers.get('location'), /\/admin\/themes\/current\/editor/, 'goes to the theme editor to switch the block on');
  const rec = await t.store.getShop(SHOP);
  assert.ok(rec.token.startsWith('enc1:') && !rec.token.includes('shpat_secret'));
  assert.equal(decryptToken(rec.token, APP), 'shpat_secret');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await t.store.listProducts(SHOP)).length, 3, 'all products pulled with the Admin API, following pagination');
  await t.close();
});

const hook = (t, topic, payload, secret = 'sec', shop = SHOP) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return t.call('POST', '/webhooks/shopify', raw, { 'x-shopify-hmac-sha256': hmacB64(raw, secret), 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop });
};
test('webhooks: signature required; product changes, deletes and uninstall keep the catalogue current', async () => {
  const t = await boot({ env: APP });
  await t.store.putShop(SHOP, { token: null });
  assert.equal((await hook(t, 'products/update', { id: 1 }, 'wrong')).status, 401);
  const raw = Buffer.from('{}');
  assert.equal((await t.call('POST', '/webhooks/shopify', raw, { 'x-shopify-topic': 'products/update' })).status, 401);

  const hat = { id: 777, title: 'New Fedora', handle: 'new-fedora', product_type: 'Hats', tags: '', options: [{ name: 'Color' }], images: [], variants: [{ id: 1, title: 'Black', option1: 'Black' }] };
  assert.equal((await hook(t, 'products/create', hat)).status, 200);
  assert.equal((await t.store.getProduct(SHOP, 'new-fedora')).title, 'New Fedora');
  assert.equal((await hook(t, 'products/update', { ...hat, title: 'New Fedora 2' })).status, 200);
  assert.equal((await t.store.getProduct(SHOP, 'new-fedora')).title, 'New Fedora 2');
  assert.equal((await hook(t, 'products/delete', { id: 777 })).status, 200);
  assert.equal(await t.store.getProduct(SHOP, 'new-fedora'), null);
  assert.equal((await hook(t, 'customers/data_request', { customer: { id: 1 } })).status, 200);
  assert.equal((await hook(t, 'customers/redact', { customer: { id: 1 } })).status, 200);
  await t.store.putProducts(SHOP, [{ ...hat, handle: 'x', fetchedAt: 1, variants: [], images: [], options: [], tags: [], type: '' }]);
  assert.equal((await hook(t, 'app/uninstalled', {})).status, 200);
  const gone = await t.store.getShop(SHOP);
  assert.equal(gone.status, 'disconnected', 'kept (with its credit balance) but disconnected');
  assert.equal(gone.token, null);
  assert.equal((await hook(t, 'shop/redact', {})).status, 200);
  assert.equal(await t.store.getShop(SHOP), null, 'shop/redact removes the store data');
  assert.equal((await t.store.listProducts(SHOP)).length, 0);
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).status, 403, 'uninstalled store is refused');
  await t.close();
});

test('admin: sync a whole store and list what is try-on ready (needs the secret)', async () => {
  const t = await boot({ env: { ...APP, OPEN_SHOPS: '1' } });
  assert.equal((await t.call('POST', '/admin/sync', { shop: SHOP })).status, 401);
  assert.equal((await t.call('GET', `/admin/catalog?shop=${SHOP}`, null, { authorization: 'Bearer nope' })).status, 401);
  const H = { authorization: 'Bearer adm' };
  const s = await t.call('POST', '/admin/sync', { shop: SHOP }, H);
  assert.equal(s.json.products, 5, s.text);
  const c = await t.call('GET', `/admin/catalog?shop=${SHOP}`, null, H);
  assert.equal(c.json.total, 5);
  assert.equal(c.json.tryable, 4);
  assert.deepEqual(c.json.products.map((p) => [p.handle, p.category]).sort(), [['classic-wool-beanie', 'hat'], ['gold-hoops', 'earrings'], ['hair-oil', null], ['kinky-straight', 'hair'], ['steel-watch', 'wrist']]);
  await t.close();
  const off = await boot({ env: {} });
  assert.equal((await off.call('POST', '/admin/sync', { shop: SHOP })).status, 404, 'admin is off without ADMIN_SECRET');
  await off.close();
});

test('hints and new categories: watch -> wrist, ring -> ring, earrings keep the face; hints come with the product', async () => {
  const t = await boot({ env: CF });
  const get = async (handle) => (await t.call('GET', `/api/product?shop=${SHOP}&handle=${handle}`)).json;
  const watch = await get('steel-watch');
  assert.equal(watch.category.id, 'wrist');
  assert.equal(watch.keepFace, false);
  assert.match(watch.photoHint, /wrist/);
  const ears = await get('gold-hoops');
  assert.equal(ears.category.id, 'earrings');
  assert.equal(ears.keepFace, true);
  assert.match(ears.photoHint, /ear/);
  assert.equal((await get('classic-wool-beanie')).keepFace, true);
  assert.equal((await t.call('POST', '/api/tryon', body({ handle: 'steel-watch', variantId: '5101' }))).json.keepFace, false);
  await t.close();
});

test('a result with no visible change for a small item is retried, then the shopper gets the photo hint', async () => {
  const world = makeWorld();
  world.aiOut = JPEG; // the AI hands the photo back
  const t = await boot({ env: CF, world });
  const r = await t.call('POST', '/api/tryon', body({ handle: 'gold-hoops', variantId: '4001' }));
  assert.equal(r.status, 422);
  assert.match(r.json.error, /ear/);
  assert.equal(world.calls.filter((c) => c.url.includes('api.cloudflare.com')).length, 2);
  await t.close();
});

test('stores with their own domain: the myshopify.com page redirects there and we follow it safely', async () => {
  const world = makeWorld();
  world.redirects = { [SHOP]: 'https://shop.example.com' };
  const t = await boot({ env: CF, world });
  const r = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.category.id, 'hat');
  assert.ok(world.calls.some((c) => c.url.startsWith('https://shop.example.com/products/classic-wool-beanie.js')));
  await t.close();
});

test('redirects that could be abused are refused (other path, http, IP address, local name)', async () => {
  for (const target of ['https://shop.example.com/evil.js', 'http://shop.example.com', 'https://169.254.169.254', 'https://[::1]', 'https://service.internal', 'https://localhost']) {
    const world = makeWorld();
    world.redirects = { [SHOP]: target };
    const t = await boot({ env: CF, world });
    const r = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
    assert.equal(r.status, 502, target);
    assert.ok(!world.calls.some((c) => /169\.254|::1|\.internal|localhost|evil\.js/.test(c.url)), `never requested ${target}`);
    await t.close();
  }
});

test('ALLOWED_SHOPS restricts the service to your store even without a Shopify app; without it any store may use it', async () => {
  const locked = await boot({ env: { ...CF, OPEN_SHOPS: undefined, ALLOWED_SHOPS: SHOP } });
  assert.equal((await locked.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).status, 200);
  assert.equal((await locked.call('GET', '/api/product?shop=other-store.myshopify.com&handle=classic-wool-beanie')).status, 403);
  assert.equal((await locked.call('POST', '/api/tryon', body({ shop: 'other-store.myshopify.com' }))).status, 403);
  await locked.close();
  const open = await boot({ env: { ...CF, OPEN_SHOPS: undefined } });
  assert.equal((await open.call('GET', '/api/product?shop=other-store.myshopify.com&handle=classic-wool-beanie')).status, 200);
  await open.close();
});

test('CORS: open by default; with ALLOWED_SHOPS your own store pages are allowed automatically; other domains need CORS_ORIGINS', async () => {
  const origin = (t, o, path = '/api/config') => fetch(t.base + path, { headers: { Origin: o } }).then((r) => r.headers.get('access-control-allow-origin'));
  const open = await boot({ env: { ...CF, OPEN_SHOPS: undefined } });
  assert.equal(await origin(open, 'https://anything.example'), '*');
  await open.close();

  const locked = await boot({ env: { ...CF, OPEN_SHOPS: undefined, ALLOWED_SHOPS: SHOP, CORS_ORIGINS: 'https://radrasa.com' } });
  assert.equal(await origin(locked, `https://${SHOP}`), `https://${SHOP}`, 'the store\'s own myshopify.com pages');
  assert.equal(await origin(locked, 'https://radrasa.com'), 'https://radrasa.com', 'listed custom domain');
  assert.equal(await origin(locked, 'https://evil.example'), null);
  assert.equal(await origin(locked, 'https://other-store.myshopify.com'), null);
  assert.equal(await origin(locked, `http://${SHOP}`), null, 'https only');
  const pre = await fetch(locked.base + '/api/tryon', { method: 'OPTIONS', headers: { Origin: `https://${SHOP}`, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), `https://${SHOP}`);
  await locked.close();
});
