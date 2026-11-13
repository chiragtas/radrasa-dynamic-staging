import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { boot, makeWorld, SHOP, renderLiquid } from './helpers.mjs';

const liquid = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/snippets/lookon-tryon.liquid', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/assets/product-tryon.js', import.meta.url), 'utf8');
const CF = { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', RATE_PER_MINUTE: '50' };

// A synthetic face (normalized coordinates) using the landmark numbers the block reads.
// dx/dy move the whole face (a pure shift is fine: it is absorbed when the faces are aligned). `reshaped` changes the face shape, as the AI sometimes does.
function face(dx = 0, dy = 0, reshaped = false) {
  const L = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
  OVAL.forEach((idx, i) => { const a = (i / OVAL.length) * 2 * Math.PI - Math.PI / 2; L[idx] = { x: 0.5 + 0.2 * Math.cos(a), y: 0.5 + 0.28 * Math.sin(a) }; });
  Object.assign(L, {});
  const set = (i, x, y) => { L[i] = { x, y }; };
  set(10, 0.5, 0.22); set(152, 0.5, 0.78); set(234, 0.3, 0.5); set(454, 0.7, 0.5);
  [70, 63, 105, 66, 107].forEach((i, k) => set(i, 0.36 + k * 0.03, 0.42)); [300, 293, 334, 296, 336].forEach((i, k) => set(i, 0.54 + k * 0.03, 0.42));
  set(33, 0.4, 0.45); set(263, 0.6, 0.45); set(13, 0.5, 0.66); set(14, 0.5, 0.67); set(1, 0.5, 0.55); set(61, 0.45, 0.67); set(291, 0.55, 0.67); set(50, 0.38, 0.58); set(280, 0.62, 0.58);
  if (reshaped === 'small') { L[152].y += 0.03; L[1].y += 0.05; } // what the AI does when it changes the hair: a slightly different chin and nose position
  else if (reshaped) { L[152].y += 0.3; L[1].y += 0.2; L[10].y -= 0.15; } // a completely different face
  return L.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

function dom(extra = {}) {
  const html = renderLiquid(liquid);
  const d = new JSDOM(`<!doctype html><body>${html}`, { url: 'https://x.myshopify.com/', runScripts: 'outside-only', pretendToBeVisual: true, resources: 'usable' });
  d.window.fetch = () => new Promise(() => {}); // pages that do not set up a server stay idle
  Object.assign(d.window, extra);
  return d.window;
}

test('mergeFace: the real face is kept, everything outside the face stays AI-made', () => {
  const w = dom({ __PTN_TEST__: {} });
  w.eval(script);
  const mk = (W, H, fill, dark) => { const c = w.document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.fillStyle = fill; x.fillRect(0, 0, W, H); if (dark) { x.fillStyle = '#000'; x.fillRect(W * 0.5 - 6, H * 0.55 - 6, 12, 12); } return c; };
  const photo = mk(400, 500, 'rgb(200,150,120)', true);   // real photo: a dark mark at the nose
  const ai = mk(300, 375, 'rgb(200,150,120)', false);       // AI picture: same skin tone, no mark
  const out = w.__PTN_TEST__.mergeFace(photo, ai, face(), face());
  assert.ok(out, 'faces line up exactly, so it merges');
  assert.equal(out.height, 1024, 'upscaled so the real face stays sharp');
  const px = (x, y) => out.getContext('2d').getImageData(Math.round(x * out.width), Math.round(y * out.height), 1, 1).data;
  assert.ok(px(0.5, 0.55)[0] < 60, 'the real face detail is on top');
  const corner = px(0.03, 0.03);
  assert.deepEqual([corner[0], corner[1], corner[2]], [200, 150, 120], 'outside the face is untouched AI picture');
  assert.ok(w.__PTN_TEST__.mergeFace(photo, ai, face(), face(0.09, 0.06)), 'a plain shift of the face is still aligned');
  assert.equal(w.__PTN_TEST__.mergeFace(photo, ai, face(), face(0, 0, true)), null, 'a completely different face is never pasted');
  w.close();
});

test('mergeFace: a face the AI slightly reshaped is still matched; the real nose lands where the AI put its nose', () => {
  const w = dom({ __PTN_TEST__: {} });
  w.eval(script);
  const mk = (W, H, fill, dark) => { const c = w.document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.fillStyle = fill; x.fillRect(0, 0, W, H); if (dark) { x.fillStyle = '#000'; x.fillRect(W * 0.5 - 6, H * 0.55 - 6, 12, 12); } return c; };
  const photo = mk(400, 500, 'rgb(200,150,120)', true);   // dark mark at the real nose (0.5, 0.55)
  const ai = mk(300, 375, 'rgb(200,150,120)', false);
  const out = w.__PTN_TEST__.mergeFace(photo, ai, face(), face(0, 0, 'small')); // the AI's nose sits 0.05 lower
  assert.ok(out, 'small differences are warped away, not refused');
  const px = (x, y) => out.getContext('2d').getImageData(Math.round(x * out.width), Math.round(y * out.height), 1, 1).data;
  assert.ok(px(0.5, 0.60)[0] < 80, 'real nose detail follows the AI face geometry');
  assert.ok(px(0.5, 0.52)[0] > 150, 'and is no longer where the old nose was');
  const tris = w.__PTN_TEST__.delaunay([[0, 0], [10, 0], [0, 10], [10, 10], [5, 5]]);
  assert.equal(tris.length, 4);
  w.close();
});

async function page(t, handle, landmarker) {
  const w = dom({ __PTN_LANDMARKER__: landmarker });
  const root = w.document.querySelector('.ptn');
  Object.assign(root.dataset, { api: t.base, shop: SHOP, handle, variant: '1001', category: '', label: 'Choose photo' });
  w.fetch = (u, i) => fetch(u, i);
  w.createImageBitmap = async () => { const c = w.document.createElement('canvas'); c.width = 600; c.height = 800; const x = c.getContext('2d'); x.fillStyle = '#c8967a'; x.fillRect(0, 0, 600, 800); return c; };
  w.eval(script);
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); } };
  const choose = () => { const inp = root.querySelector('.ptn-file'); Object.defineProperty(inp, 'files', { value: [new w.File([new Uint8Array(10)], 'me.jpg', { type: 'image/jpeg' })], configurable: true }); inp.dispatchEvent(new w.Event('change')); };
  return { w, root, until, choose, text: () => root.querySelector('.ptn-status').textContent + (root.querySelector('.ptn-alert').hidden ? '' : ' ' + root.querySelector('.ptn-alert-title').textContent + ' ' + root.querySelector('.ptn-alert-msg').textContent), $: (s) => root.querySelector(s) };
}

test('block: shows the photo hint for the product (earrings: ears; watch: wrist)', async () => {
  const t = await boot({ env: CF });
  const e = await page(t, 'gold-hoops');
  await e.until(() => e.root.dataset.state === 'ready');
  assert.match(e.$('.ptn-hint').textContent, /ear/);
  const wt = await page(t, 'steel-watch');
  await wt.until(() => wt.root.dataset.state === 'ready');
  assert.match(wt.$('.ptn-hint').textContent, /wrist/);
  assert.match(wt.$('.ptn-hint').textContent, /face photo will not work/);
  e.w.close(); wt.w.close(); await t.close();
});

test('block: real face kept when the faces line up; the shopper can switch to the plain AI picture', async () => {
  const t = await boot({ env: CF });
  const lm = { detect: (c) => ({ faceLandmarks: [face()] }) };
  const p = await page(t, 'classic-wool-beanie', lm);
  await p.until(() => p.root.dataset.state === 'ready');
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => /kept exactly/.test(p.text()));
  assert.equal(p.$('.ptn-keep').hidden, false);
  const merged = p.$('.ptn-result').src;
  assert.ok(merged.startsWith('data:image/jpeg'));
  p.$('.ptn-keepface').checked = false;
  p.$('.ptn-keepface').dispatchEvent(new p.w.Event('change'));
  assert.notEqual(p.$('.ptn-result').src, merged, 'plain AI picture shown when unticked');
  p.$('.ptn-keepface').checked = true;
  p.$('.ptn-keepface').dispatchEvent(new p.w.Event('change'));
  assert.equal(p.$('.ptn-result').src, merged);
  p.w.close(); await t.close();
});

test('block: if the AI moved the face, the plain AI picture is shown with an honest message (no pasted face)', async () => {
  const t = await boot({ env: CF });
  const lm = { detect: (c) => ({ faceLandmarks: [c.width === 600 ? face() : face(0, 0, true)] }) }; // the AI changed the face shape
  const p = await page(t, 'classic-wool-beanie', lm);
  await p.until(() => p.root.dataset.state === 'ready');
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => /could not line your face up/.test(p.text()));
  assert.ok(p.$('.ptn-result').src.startsWith('data:image/'));
  p.w.close(); await t.close();
});

const hand = (over = {}) => Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + (i % 5) * 0.1, y: 0.4 + Math.floor(i / 5) * 0.1, ...(over[i] || {}) }));
const shrunk = (L, k) => L.map((p) => ({ x: 0.5 + (p.x - 0.5) * k, y: 0.5 + (p.y - 0.5) * k }));
const send = async (t, handle, { lm, hands }, wait = /AI preview of/) => {
  const p = await page(t, handle, lm);
  if (hands) p.w.__PTN_HANDS__ = hands;
  await p.until(() => p.root.dataset.state === 'ready');
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  return p;
};
const aiCalls = (t) => t.world.calls.filter((c) => c.url.includes('api.cloudflare.com')).length;

test('photo check: a face photo for a watch is refused before any AI call; "Try anyway" still lets the shopper go on', async () => {
  const t = await boot({ env: CF });
  const p = await send(t, 'steel-watch', { lm: { detect: () => ({ faceLandmarks: [face()] }) }, hands: { detect: () => ({ landmarks: [] }) } });
  await p.until(() => /could not find a hand or wrist/.test(p.text()));
  assert.match(p.text(), /face photo will not work/);
  assert.equal(aiCalls(t), 0, 'no AI call was spent');
  assert.equal(p.$('.ptn-anyway').hidden, false);
  p.$('.ptn-anyway').click();
  await p.until(() => /AI preview of/.test(p.text()));
  assert.equal(aiCalls(t), 1);
  p.w.close(); await t.close();
});

test('photo check: a hand photo goes straight through for a watch; cut-off wrists and fingers are caught', async () => {
  const t = await boot({ env: CF });
  const ok = await send(t, 'steel-watch', { hands: { detect: () => ({ landmarks: [hand()] }) } });
  await ok.until(() => /AI preview of/.test(ok.text()));
  assert.equal(ok.$('.ptn-anyway').hidden, true);
  const cut = await send(t, 'steel-watch', { hands: { detect: () => ({ landmarks: [hand({ 0: { y: 1.0 } })] }) } });
  await cut.until(() => /wrist is cut off/.test(cut.text()));
  ok.w.close(); cut.w.close(); await t.close();
});

test('photo check: no face for a hat, a tiny face, cut-off ears (earrings) and no neck room (necklace) are all caught first', async () => {
  const world = makeWorld();
  world.products['pearl-necklace'] = { id: 600, title: 'Pearl Pendant Necklace', handle: 'pearl-necklace', type: 'Jewellery', tags: [], options: [], featured_image: 'https://cdn.shopify.com/s/files/1/0001/products/pearl.jpg', images: ['https://cdn.shopify.com/s/files/1/0001/products/pearl.jpg'], variants: [{ id: 6001, title: 'Default Title', options: ['Default Title'], available: true }] };
  const t = await boot({ env: CF, world });
  const lmOf = (fn) => ({ detect: () => ({ faceLandmarks: fn() }) });
  const cases = [
    ['classic-wool-beanie', lmOf(() => []), /could not find a face/],
    ['classic-wool-beanie', lmOf(() => [shrunk(face(), 0.2)]), /face looks very small/],
    ['gold-hoops', lmOf(() => { const L = face(); L[234].x = 0.0; return [L]; }), /ears are cut off/],
    ['pearl-necklace', lmOf(() => { const L = face(); L[152].y = 0.97; return [L]; }), /neck and shoulders/],
  ];
  for (const [handle, lm, re] of cases) {
    const p = await send(t, handle, { lm });
    await p.until(() => re.test(p.text()));
    p.w.close();
  }
  assert.equal(aiCalls(t), 0, 'none of these photos reached the AI');
  await t.close();
});

test('photo check: if the detector cannot run, the shopper is never blocked', async () => {
  const t = await boot({ env: CF });
  const p = await send(t, 'classic-wool-beanie', { lm: { detect: () => { throw new Error('model failed to load'); } } });
  await p.until(() => /AI preview of/.test(p.text()));
  assert.equal(p.$('.ptn-anyway').hidden, true);
  assert.equal(aiCalls(t), 1);
  p.w.close(); await t.close();
});
