// Builds the instruction for the AI from validated data only (category, product title, selected options).
// The browser never sends prompt text. Store-supplied text (title, options) is cleaned and length-limited first.
import { CATEGORIES } from './categories.js';

const clean = (s, max = 120) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[<>{}`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function lengthPhrase(x) {
  if (x <= 9) return 'jaw length';
  if (x <= 11) return 'chin length, just above the shoulders';
  if (x <= 13) return 'shoulder length';
  if (x <= 15) return 'just below the shoulders';
  if (x <= 17) return 'collarbone to upper chest';
  if (x <= 19) return 'mid-chest';
  if (x <= 21) return 'around the ribcage';
  if (x <= 23) return 'mid-back';
  if (x <= 25) return 'lower back';
  if (x <= 27) return 'waist length';
  if (x <= 29) return 'hip length';
  if (x <= 33) return 'below the hips';
  return 'thigh length';
}

/** "22 inch", 22", 22in -> 22. A bare number only counts when the option itself is called Length/Size. */
export function inchesFromOptions(options, names = []) {
  for (let i = 0; i < options.length; i++) {
    const m = String(options[i]).match(/(\d+(?:\.\d+)?)\s*(?:"|”|in\b|inch|inches)/i) || (/length/i.test(names[i] || '') && String(options[i]).match(/(\d+(?:\.\d+)?)/));
    if (m) {
      const n = Number(m[1]);
      if (n >= 4 && n <= 60) return n;
    }
  }
  return null;
}

// When the browser sends a close-up crop (small items), the AI is told what it is looking at, so it cannot
// mistake the crop for a whole new portrait or put the item somewhere else.
const FOCUS_LINES = {
  nose: 'Image 1 is a close-up crop of the middle of the person\'s face (eyes, nose, mouth). Add the item to one nostril only. Change nothing else: every other pixel of image 1 stays exactly the same, same crop, same zoom.',
  ears: 'Image 1 is a close-up crop of the person\'s head showing both ears. Add the item to the earlobes only. Change nothing else: the face, hair, skin and background stay exactly the same, same crop, same zoom.',
  neck: 'Image 1 is a close-up crop of the person\'s chin, neck and upper chest. Add the item around the neck only. Change nothing else: skin, clothing and background stay exactly the same, same crop, same zoom.',
  'ears+neck': 'Image 1 is a close-up crop of the person\'s head, ears, neck and upper chest. Add the earrings to the earlobes and the necklace around the neck only. Change nothing else: the face, hair, skin, clothing and background stay exactly the same, same crop, same zoom.',
};

export function buildPrompt({ categoryId, product, variant, optionNames = [], compact = false, focus = null }) {
  const cat = CATEGORIES[categoryId];
  const title = clean(product.title);
  const chosen = (variant?.options || []).map((v, i) => (optionNames[i] ? `${clean(optionNames[i], 30)}: ${clean(v, 50)}` : clean(v, 50))).filter(Boolean);
  const optionLine = chosen.length ? `Selected option: ${chosen.join(', ')}. If the product photo shows a different colour or size from the selected option, follow the selected option.` : '';
  let lengthLine = '';
  if (cat.lengthAware) {
    const inches = inchesFromOptions(variant?.options || [], optionNames);
    if (inches) lengthLine = `Length: ${inches} inches; on this person it should visibly reach about ${lengthPhrase(inches * 0.9)}.`;
  }
  const lines = [
    'You are given two images. Image 1 is a photo of a person. Image 2 is a product photo of "' + title + '".',
    `Edit image 1 so the person is ${cat.placement}.`,
    focus && FOCUS_LINES[focus] ? FOCUS_LINES[focus] : '',
    'Reproduce the product from image 2 faithfully: its exact shape, colour, material, pattern, texture and details. Do not invent a different design.',
    'Image 2 may show the product on a model, a mannequin or a background: copy only the product itself. Never copy that person\'s face, skin, body or the background into the result.',
    optionLine,
    lengthLine,
    'Keep the same person: identical face shape, eyes, eyebrows, nose, lips, skin tone, expression, head pose and camera angle. Do not beautify, smooth, slim or age the face.',
    'Keep the exact proportions of image 1: do not stretch, squash, widen or warp the face, head or body, and do not change the image shape or crop.',
    'Keep the clothing, background, lighting and framing exactly as in image 1, except where the product covers it.',
    'Make the result photorealistic: match the lighting, shadows and perspective of image 1 and scale the product to its true size on this person, neither oversized nor tiny.',
    compact ? '' : 'If the part of the body needed for this product is not visible in image 1, show as much as fits naturally and do not change the framing.',
    compact ? '' : 'Return only the edited version of image 1: one photograph, no text, logos, watermarks, borders, collages or before-and-after splits.',
    compact ? '' : 'If there is no clearly visible person in image 1, do not generate an image and reply with a short text explanation instead.',
  ];
  return lines.filter(Boolean).join(compact ? ' ' : '\n');
}
