// Runs the real theme-block script in a simulated browser against the real server (with a fake Shopify / AI behind it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { boot, SHOP } from './helpers.mjs';
import { renderLiquid } from './helpers.mjs';

const liquid = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/snippets/lookon-tryon.liquid', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/assets/product-tryon.js', import.meta.url), 'utf8');

// Minimal Liquid: drop tags/comments/schema, fill the few {{ }} values the block uses.
const render = (vars) => renderLiquid(liquid, vars);

async function page(t, { handle, variant = '1001', category = '', settings = {} }) {
  const html = render({
    api: t.base, 'shop.permanent_domain': SHOP, 'product.handle': handle, 'product.selected_or_first_available_variant.id': variant,
    'product.metafields.custom.tryon_category.value': category, 'block.settings.button_label': 'Choose photo', 'block.settings.accent': '#111',
    'block.settings.heading': 'Try it on', 'block.settings.subheading': 'sub', 'block.id': 'b1', 'block.shopify_attributes': '', placement: 'auto',
    ...settings,
  });
  const dom = new JSDOM(`<!doctype html><body><form action="/cart/add"><input name="id" value="${variant}"></form>${html}`, { url: 'https://cool-store.myshopify.com/products/' + handle, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (u, i) => fetch(u, i);
  w.createImageBitmap = async () => { const c = w.document.createElement('canvas'); c.width = 600; c.height = 800; return c; };
  w.eval(script);
  const root = w.document.querySelector('.ptn');
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); } };
  const choose = (file = new w.File([new Uint8Array(10)], 'me.jpg', { type: 'image/jpeg' })) => {
    const inp = root.querySelector('.ptn-file');
    Object.defineProperty(inp, 'files', { value: [file], configurable: true });
    inp.dispatchEvent(new w.Event('change'));
  };
  return { w, root, until, choose, text: () => root.querySelector('.ptn-status').textContent + (root.querySelector('.ptn-alert').hidden ? '' : ' ' + root.querySelector('.ptn-alert-title').textContent + ' ' + root.querySelector('.ptn-alert-msg').textContent), $: (s) => root.querySelector(s), close: () => w.close() };
}

test('block: shows only on wearable products and names the category', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' } });
  const hat = await page(t, { handle: 'classic-wool-beanie' });
  await hat.until(() => hat.root.dataset.state === 'ready');
  assert.match(hat.$('.ptn-btn-label').textContent, /try on hat \/ cap/);
  const oil = await page(t, { handle: 'hair-oil' });
  await oil.until(() => oil.root.dataset.state === 'hidden');
  assert.equal(oil.root.hidden, true, 'a care product gets no try-on');
  hat.close(); oil.close(); await t.close();
});

test('block: photo -> AI preview of the selected variant; changing the variant offers a new preview', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', RATE_PER_MINUTE: '20' } });
  const p = await page(t, { handle: 'classic-wool-beanie', variant: '1002' });
  await p.until(() => p.root.dataset.state === 'ready');

  p.choose();
  await p.until(() => /tick the box/.test(p.text()));
  assert.equal(t.world.cf, undefined, 'nothing is sent without consent');

  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => !p.$('.ptn-stage').hidden && !p.root.classList.contains('ptn-generating') && p.$('.ptn-result').src.startsWith('data:'));
  assert.match(p.text(), /Classic Wool Beanie \(Blue \/ S\)/);
  const form = t.world.cf.form;
  assert.ok(form.get('input_image_0') && form.get('input_image_1'));
  assert.match(form.get('prompt'), /Color: Blue/);
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /blue\.jpg/);
  assert.equal(form.get('width'), '576', '600x800 photo was reduced to 360x480 for Cloudflare and keeps its shape');
  assert.equal(form.get('height'), '768');
  assert.equal(p.$('.ptn-regen').hidden, true);

  // shopper picks the red variant on the page
  p.w.document.querySelector('form [name="id"]').value = '1001';
  await p.until(() => !p.$('.ptn-regen').hidden, 3000);
  p.$('.ptn-regen').click();
  await p.until(() => /Red \/ S/.test(p.text()));
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /red\.jpg/);
  assert.equal(p.$('.ptn-regen').hidden, true);

  const preview = p.$('.ptn-result').src;
  p.$('.ptn-toggle').click();
  assert.notEqual(p.$('.ptn-result').src, preview, 'shows the original photo');
  p.$('.ptn-toggle').click();
  assert.equal(p.$('.ptn-result').src, preview);
  p.close(); await t.close();
});

test('block: server errors are shown to the shopper in plain words', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', DAILY_CAP_PER_SHOP: '0' } });
  const p = await page(t, { handle: 'classic-wool-beanie' });
  await p.until(() => p.root.dataset.state === 'ready');
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => /reached today/.test(p.text()));
  assert.equal(p.$('.ptn-stage').hidden, true);
  p.close(); await t.close();
});

test('block: sits right before the Add to cart form; hidden on pages that are not products', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' } });
  const hat = await page(t, { handle: 'classic-wool-beanie' });
  assert.equal(hat.root.hidden, false, 'shown at once on a product page');
  const form = hat.w.document.querySelector('form[action="/cart/add"]');
  assert.equal(hat.root.nextElementSibling, form, 'moved next to the buy button');
  assert.equal(hat.root.dataset.mounted, '1');
  // the theme re-renders the product form after a variant change: the block follows it
  const fresh = hat.w.document.createElement('form'); fresh.setAttribute('action', '/cart/add');
  form.replaceWith(fresh);
  await hat.until(() => hat.root.nextElementSibling === fresh);
  const home = await page(t, { handle: '' });
  assert.equal(home.root.hidden, true);
  hat.close(); home.close(); await t.close();
});

test('block: the app block stays where the merchant put it; the embed honours its position and steps aside for the block', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' } });
  const manual = await page(t, { handle: 'classic-wool-beanie', settings: { placement: 'manual' } });
  const form = manual.w.document.querySelector('form[action="/cart/add"]');
  assert.equal(manual.root.previousElementSibling, form, 'not moved');
  assert.equal(manual.root.dataset.mounted, undefined);
  manual.close();
  const below = await page(t, { handle: 'classic-wool-beanie', settings: { 'block.settings.position': 'after_cart' } });
  await below.until(() => below.root.previousElementSibling === below.w.document.querySelector('form[action="/cart/add"]'));
  below.close();
  const html = (placement, id) => renderLiquid(liquid, { api: t.base, 'shop.permanent_domain': SHOP, 'product.handle': 'classic-wool-beanie', 'product.selected_or_first_available_variant.id': '1001', 'block.id': id, placement });
  const dom = new JSDOM(`<!doctype html><body><div class="info"><form action="/cart/add"></form>${html('manual', 'm')}</div>${html('auto', 'a')}`, { url: 'https://cool-store.myshopify.com/products/classic-wool-beanie', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = (u, i) => fetch(u, i);
  dom.window.eval(script);
  const t0 = Date.now();
  while (dom.window.document.querySelectorAll('.ptn').length > 1 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  const roots = dom.window.document.querySelectorAll('.ptn');
  assert.equal(roots.length, 1, 'only one try-on on the page');
  assert.equal(roots[0].id, 'ptn-m');
  await new Promise((r) => setTimeout(r, 100));
  dom.window.close(); await t.close();
});

test('block: theme editor wording is kept unless the merchant changed that line in the lookOn app', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' } });
  const theme = { 'block.settings.subheading': 'From the theme', 'block.settings.selfie_label': 'Selfie!', 'block.settings.button_label': 'Upload' };
  const a = await page(t, { handle: 'classic-wool-beanie', settings: theme });
  await a.until(() => a.root.dataset.state === 'ready');
  assert.equal(a.$('.ptn-sub').textContent, 'From the theme');
  assert.equal(a.$('.ptn-selfie').textContent, 'Selfie!');
  assert.equal(a.$('.ptn-btn-label').textContent, 'Upload', 'a custom theme label is not replaced');
  assert.match(a.$('.ptn-hint').textContent, /head/, 'the default theme hint gives way to the category hint');
  await t.store.putShop(SHOP, { widget: { texts: { subheading: 'From the app', consent: 'App consent' } } });
  const b = await page(t, { handle: 'classic-wool-beanie', settings: theme });
  await b.until(() => b.root.dataset.state === 'ready');
  assert.equal(b.$('.ptn-sub').textContent, 'From the app', 'app text wins');
  assert.equal(b.$('.ptn-consent span').textContent, 'App consent');
  assert.equal(b.$('.ptn-selfie').textContent, 'Selfie!', 'untouched lines keep the theme value');
  a.close(); b.close(); await t.close();
});

test('block: a scanner runs over the shopper photo while the preview is made, then gives way to the result', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', RATE_PER_MINUTE: '20' } });
  t.world.aiDelay = 700;
  const p = await page(t, { handle: 'classic-wool-beanie' });
  await p.until(() => p.root.dataset.state === 'ready');
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => p.root.classList.contains('ptn-scanning') && p.root.classList.contains('ptn-generating'));
  assert.equal(p.$('.ptn-stage').hidden, false, 'the shopper sees their own photo under the scanner');
  assert.ok(p.$('.ptn-result').src.startsWith('data:'));
  await p.until(() => /Scanning your photo/.test(p.$('.ptn-scan-step').textContent));
  assert.ok(parseFloat(p.$('.ptn-scan-bar > span').style.width) > 0, 'progress bar moves');
  await p.until(() => !p.root.classList.contains('ptn-scanning') && !p.root.classList.contains('ptn-generating'));
  assert.equal(p.$('.ptn-alert').hidden, true);
  p.close(); await t.close();
});

test('block: when the preview fails the shopper gets plain words and a Try again button, never provider details', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', RATE_PER_MINUTE: '20' } });
  t.world.aiFail = 401;
  const p = await page(t, { handle: 'classic-wool-beanie' });
  await p.until(() => p.root.dataset.state === 'ready');
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => !p.$('.ptn-alert').hidden);
  const msg = p.text();
  assert.match(msg, /isn't available right now/);
  assert.ok(!/cloudflare|gemini|token|model|workers/i.test(msg), msg);
  assert.match(p.$('.ptn-alert-title').textContent, /temporarily|break|couldn/i);
  assert.equal(p.$('.ptn-retry').hidden, false);
  assert.equal(p.root.classList.contains('ptn-scanning'), false, 'scanner stops');
  // the service recovers: Try again uses the same photo
  t.world.aiFail = 0;
  p.$('.ptn-retry').click();
  await p.until(() => p.$('.ptn-alert').hidden && !p.root.classList.contains('ptn-generating') && /AI preview of Classic Wool Beanie/.test(p.text()));
  assert.equal(p.$('.ptn-stage').hidden, false);
  // no connection
  const realFetch = p.w.fetch;
  p.w.fetch = (u, i) => (String(u).includes('/api/tryon') ? Promise.reject(new TypeError('Failed to fetch')) : realFetch(u, i));
  p.$('.ptn-retry').click();
  await p.until(() => /offline/.test(p.text()));
  assert.ok(!/Failed to fetch/.test(p.text()));
  p.close(); await t.close();
});
