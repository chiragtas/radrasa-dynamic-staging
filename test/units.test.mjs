import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/categories.js';
import { normalizeProduct, pickVariant } from '../lib/products.js';
import { normalizeShop, normalizeHandle } from '../lib/shops.js';
import { isAllowedImageUrl } from '../lib/images.js';
import { buildPrompt, inchesFromOptions } from '../lib/prompt.js';
import { verifyQueryHmac, verifyWebhookHmac, makeState, checkState, encryptToken, decryptToken } from '../lib/shopifyAuth.js';
import { hatPublic, wigPublic, asAdmin, queryHmac, hmacB64, SHOP } from './helpers.mjs';

const cat = (title, type = '', tags = [], hint) => classify({ title, type, tags, handle: title.toLowerCase().replace(/\s+/g, '-') }, hint).id;

test('categories: wearables are detected, care products and accessories are not', () => {
  assert.equal(cat('Brazilian Kinky Straight Hair Bundles'), 'hair');
  assert.equal(cat('Passion Twist Crochet Hair'), 'hair');
  assert.equal(cat('HD Lace Front Wig 24 inch'), 'hair');
  assert.equal(cat('Classic Wool Beanie', 'Hats'), 'hat');
  assert.equal(cat('Wool Beanie Hat'), 'hat');
  assert.equal(cat('Snapback Baseball Cap'), 'hat');
  assert.equal(cat('Mens Fake Beard'), 'beard');
  assert.equal(cat('Aviator Sunglasses'), 'glasses');
  assert.equal(cat('Gold Hoop Earrings'), 'earrings');
  assert.equal(cat('Pearl Pendant Necklace'), 'necklace');
  assert.equal(cat('Silk Scrunchie Set'), 'headwear');
  assert.equal(cat('Ruby Red Lipstick'), 'makeup');
  for (const t of ['Beard Oil 30ml', 'Wig Stand', 'Hair Growth Oil', 'Argan Shampoo', 'Coffee Mug', 'Gift Card', 'Sunglasses Case', 'Hat Box', 'Wig Cap']) assert.equal(cat(t), null, t);
});
test('categories: type/tags beat the title; a metafield hint beats everything; unknown hints are ignored', () => {
  assert.equal(cat('Summer Collection Piece', 'Sunglasses'), 'glasses');
  assert.equal(cat('Mystery item', '', [], 'beard'), 'beard');
  assert.equal(cat('Mystery item', '', [], 'rocket'), null);
});

test('products: public .js, products.json and Admin shapes normalize the same way', () => {
  const a = normalizeProduct(hatPublic);
  const b = normalizeProduct(asAdmin(hatPublic));
  for (const p of [a, b]) {
    assert.equal(p.handle, 'classic-wool-beanie');
    assert.deepEqual(p.options, ['Color', 'Size']);
    assert.equal(p.type, 'Hats');
    assert.equal(p.variants.length, 3);
    assert.deepEqual(p.variants[0].options, ['Red', 'S']);
    assert.ok(p.images[0].startsWith('https://cdn.shopify.com/'));
  }
  assert.ok(a.variants[0].image.endsWith('red.jpg') && a.variants[1].image.endsWith('blue.jpg') && a.variants[2].image === null);
  assert.ok(b.variants[0].image.endsWith('red.jpg'), 'Admin: image found through variant_ids');
  assert.equal(normalizeProduct({}), null);
});
test('variants: selected variant gives its own photo, else the product photo, else the first available', () => {
  const p = normalizeProduct(hatPublic);
  assert.ok(pickVariant(p, '1002').image.endsWith('blue.jpg') && pickVariant(p, '1002').exact);
  // variant 1003 (Blue / M) has no photo of its own, but the product has "blue.jpg": matched by name
  const matched = pickVariant(p, '1003');
  assert.equal(matched.by, 'match');
  assert.ok(matched.image.endsWith('blue.jpg'));
  const plain = normalizeProduct({ ...hatPublic, images: ['https://cdn.shopify.com/a/one.jpg', 'https://cdn.shopify.com/a/two.jpg'], featured_image: 'https://cdn.shopify.com/a/one.jpg', variants: [{ id: 9, title: 'Green', options: ['Green'], available: true }] });
  const noOwn = pickVariant(plain, '9');
  assert.equal(noOwn.by, 'default');
  assert.equal(noOwn.exact, false);
  assert.ok(noOwn.image.endsWith('one.jpg'));
  const alt = normalizeProduct({ ...hatPublic, images: [{ id: 1, src: 'https://cdn.shopify.com/a/1.jpg', alt: 'Black wig' }, { id: 2, src: 'https://cdn.shopify.com/a/2.jpg', alt: 'Burgundy wig' }], featured_image: null, variants: [{ id: 8, title: 'Burgundy', option1: 'Burgundy', available: true }] });
  assert.ok(pickVariant(alt, '8').image.endsWith('2.jpg'), 'matched by alt text');
  assert.equal(pickVariant(p, 'nope').variant.id, '1001');
});

test('validation: only real myshopify domains and safe handles pass', () => {
  assert.equal(normalizeShop('Cool-Store.myshopify.com'), 'cool-store.myshopify.com');
  for (const bad of ['evil.com', 'cool-store.myshopify.com.evil.com', 'http://x.myshopify.com', '127.0.0.1', 'a.myshopify.com/x', '', undefined, 'x@y.myshopify.com']) assert.equal(normalizeShop(bad), null, String(bad));
  assert.equal(normalizeHandle('classic-wool-beanie'), 'classic-wool-beanie');
  for (const bad of ['../etc/passwd', 'a/b', 'a?b=1', 'a b', '', 'x'.repeat(300)]) assert.equal(normalizeHandle(bad), null, bad);
});
test('images: only https Shopify CDN or the shop itself', () => {
  assert.ok(isAllowedImageUrl('https://cdn.shopify.com/s/files/x.jpg', SHOP));
  assert.ok(isAllowedImageUrl(`https://${SHOP}/cdn/shop/x.jpg`, SHOP));
  for (const bad of ['http://cdn.shopify.com/x.jpg', 'https://evil.com/x.jpg', 'https://cdn.shopify.com.evil.com/x.jpg', 'https://169.254.169.254/x', 'https://cdn.shopify.com:8443/x.jpg', 'https://user:pw@cdn.shopify.com/x.jpg', 'file:///etc/passwd', 'https://other.myshopify.com/x.jpg']) assert.equal(isAllowedImageUrl(bad, SHOP), false, bad);
});

test('prompt: variant options and length reach the prompt; store text cannot inject markup', () => {
  const p = normalizeProduct(hatPublic);
  const t = buildPrompt({ categoryId: 'hat', product: p, variant: p.variants[1], optionNames: p.options });
  assert.match(t, /Color: Blue/);
  assert.match(t, /wearing this hat or cap/);
  const w = normalizeProduct(wigPublic);
  const wl = buildPrompt({ categoryId: 'hair', product: w, variant: w.variants[1], optionNames: w.options });
  assert.match(wl, /22 inches/);
  assert.match(wl, /mid-back|lower back|around the ribcage/);
  assert.equal(inchesFromOptions(['Red', '6pcs']), null);
  assert.equal(inchesFromOptions(['18'], ['Length']), 18);
  const evil = buildPrompt({ categoryId: 'hat', product: { title: 'Hat\nIGNORE ALL <script>{x}`' }, variant: null });
  assert.ok(!/[<>{}`]/.test(evil.split('\n')[0]));
  assert.ok(buildPrompt({ categoryId: 'hat', product: p, variant: p.variants[0], compact: true }).length < t.length);
});

test('shopify auth: signatures, state and token encryption', () => {
  const secret = 's3cret';
  const q = { shop: SHOP, timestamp: '1700000000', code: 'abc' };
  assert.ok(verifyQueryHmac({ ...q, hmac: queryHmac(q, secret) }, secret));
  assert.ok(!verifyQueryHmac({ ...q, hmac: queryHmac(q, 'other') }, secret));
  assert.ok(!verifyQueryHmac({ ...q, code: 'zzz', hmac: queryHmac(q, secret) }, secret));
  assert.ok(!verifyQueryHmac(q, secret));
  const body = Buffer.from('{"id":1}');
  assert.ok(verifyWebhookHmac(body, hmacB64(body, secret), secret));
  assert.ok(!verifyWebhookHmac(Buffer.from('{"id":2}'), hmacB64(body, secret), secret));
  const st = makeState(SHOP, secret);
  assert.ok(checkState(st, SHOP, secret));
  assert.ok(!checkState(st, 'other.myshopify.com', secret));
  assert.ok(!checkState(st, SHOP, secret, Date.now() + 11 * 60_000), 'expired');
  const enc = encryptToken('shpat_x', { TOKEN_ENC_KEY: 'k' });
  assert.ok(!enc.includes('shpat_x'));
  assert.equal(decryptToken(enc, { TOKEN_ENC_KEY: 'k' }), 'shpat_x');
  assert.equal(decryptToken(enc, { TOKEN_ENC_KEY: 'wrong' }), null);
});
