// Small items (nose pin, earrings, necklace): the AI only sees a close-up, and only the item's area comes back onto the real photo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildPrompt } from '../lib/prompt.js';
import { classify, CATEGORIES } from '../lib/categories.js';

const script = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/assets/product-tryon.js', import.meta.url), 'utf8');

function face() {
  const L = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const set = (i, x, y) => { L[i] = { x, y }; };
  set(10, 0.5, 0.22); set(152, 0.5, 0.62); set(234, 0.38, 0.4); set(454, 0.62, 0.4); set(1, 0.5, 0.45);
  set(98, 0.48, 0.47); set(327, 0.52, 0.47);
  [70, 63, 105, 66, 107, 300, 293, 334, 296, 336].forEach((i, k) => set(i, 0.42 + k * 0.016, 0.34));
  return L;
}

test('categories: the real store products land in the right place', () => {
  assert.equal(classify({ title: 'Fashion Crystal Stainless Steel Nose Stud Piercing for Women, Hypoallergenic 1.8mm Nose Ring, Straight/L/Screw Shaped' }).id, 'nosepin');
  assert.equal(classify({ title: 'Crocodile Jewelry Set With Earrings & Necklace' }).id, 'jewelset');
  assert.equal(classify({ title: 'Brazilian Kinky Straight Human Hair' }).id, 'hair');
  assert.equal(classify({ title: 'Straight Leg Jeans' }).id, null, '"straight" alone is not a nose pin');
  assert.equal(CATEGORIES.nosepin.keepFace, false, 'pasting the real face back would erase a nose pin');
  assert.equal(CATEGORIES.hair.keepFace, true, 'wigs keep the shopper\'s real face, not the model\'s');
});

test('prompt: a close-up crop is announced to the AI', () => {
  const p = buildPrompt({ categoryId: 'nosepin', product: { title: 'Nose Stud' }, variant: null, focus: 'nose' });
  assert.match(p, /close-up crop/);
  assert.match(p, /not an earring/);
});

test('pasteFocus: only the nostril area comes back; a drifted AI picture is lined up; everything else is the real photo', () => {
  const d = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = d.window;
  w.__PTN_TEST__ = {};
  w.fetch = () => new Promise(() => {});
  w.eval(script);
  const T = w.__PTN_TEST__;
  const W = 600, H = 400;
  // Real photo: textured so alignment has something to lock on to.
  const photo = w.document.createElement('canvas'); photo.width = W; photo.height = H;
  const px = photo.getContext('2d');
  for (let y = 0; y < H; y += 10) for (let x = 0; x < W; x += 10) { const v = 120 + ((x * 7 + y * 13) % 90); px.fillStyle = `rgb(${v},${v - 20},${v - 40})`; px.fillRect(x, y, 10, 10); }
  const L = face();
  const rect = T.focusRect('nose', L, W, H);
  // The ears (x 0.38 / 0.62 of the width) are not in the nose crop.
  assert.ok(rect.x > 0.38 * W && rect.x + rect.side < 0.62 * W, `nose crop excludes the ears: ${JSON.stringify(rect)}`);
  // AI answer: the crop shifted by 3 px, a blue stud on the nostril, and the forehead repainted red (must not survive).
  const S = 480, k = S / rect.side;
  const ai = w.document.createElement('canvas'); ai.width = S; ai.height = S;
  const ax = ai.getContext('2d');
  ax.drawImage(photo, rect.x + 3, rect.y, rect.side, rect.side, 0, 0, S, S);
  const stud = [0.52 * W, 0.47 * H];
  ax.fillStyle = 'rgb(0,90,255)'; ax.beginPath(); ax.arc((stud[0] - rect.x - 3) * k, (stud[1] - rect.y) * k, 4 * k, 0, Math.PI * 2); ax.fill();
  ax.fillStyle = 'rgb(255,0,0)'; ax.fillRect(0, 0, S, S * 0.2);
  const r = T.pasteFocus(photo, rect, ai, T.focusMask('nose', L, W, H));
  assert.ok(r.changed, 'the stud was detected');
  const o = r.canvas.getContext('2d');
  const at = (x, y) => Array.from(o.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
  const ref = (x, y) => Array.from(px.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
  const s = at(stud[0], stud[1]);
  assert.ok(s[2] > 200 && s[0] < 60, `blue stud is on the nostril: ${s}`);
  assert.deepEqual(at(rect.x + 5, rect.y + 5), ref(rect.x + 5, rect.y + 5), 'repainted forehead did not come through');
  assert.deepEqual(at(10, 10), ref(10, 10), 'outside the crop is the untouched photo');
  w.close();
});
