// Product Try-On category detection.
// Shopify metafield custom.tryon_category is an optional override.
// Otherwise detection uses product type, tags, title and handle.

export const CATEGORIES = {
  hair: {
    label: 'wig / hair',
    needs: 'face',
    keepFace: true,
    photoHint: 'Use a clear, front-facing photo with your whole head and shoulders in view.',
    placement: 'wearing this hair product (wig, hair extensions, bundles, braids or twists exactly as shown) as a complete, natural-looking head of hair that replaces their visible hair, with a believable hairline and parting',
    include: [
      'wig', 'wigs', 'lace front', 'lace frontal', 'lace closure', 'hair closure',
      'hair extension', 'hair extensions', 'clip in', 'clip ins', 'tape in',
      'weave', 'weaves', 'hair bundle', 'hair bundles', 'bundles', 'braid',
      'braids', 'braiding', 'crochet hair', 'passion twist', 'yanky twist',
      'twist braids', 'locs', 'dreadlocks', 'ponytail', 'human hair', 'remy',
      'toupee', 'hairpiece', 'hair piece', 'body wave', 'loose wave',
      'deep wave', 'kinky straight', 'curly hair', 'curly wig', 'pixie curl',
      'jerry curl', 'yaki', 'balayage', 'marley', 'brazilian wool', 'wool braid'
    ],
    exclude: [
      'wig stand', 'wig cap', 'wig glue', 'wig grip', 'wig tape', 'shampoo',
      'conditioner', 'hair oil', 'serum', 'spray', 'mousse', 'brush', 'comb',
      'bonnet', 'eyelash', 'lash', 'gift card'
    ],
    lengthAware: true
  },

  hat: {
    label: 'hat / cap',
    needs: 'face',
    keepFace: true,
    photoHint: 'Use a clear, front-facing photo with your whole head in view and some space above it.',
    placement: 'wearing this hat or cap on their head, sitting at a natural angle and the correct size for their head, with their hair showing naturally around it and a soft realistic shadow on the forehead',
    include: [
      'hat', 'hats', 'cap', 'caps', 'beanie', 'beanies', 'fedora', 'beret',
      'bucket hat', 'snapback', 'trucker', 'visor', 'turban', 'kufi',
      'cowboy hat', 'sun hat', 'baseball cap', 'helmet'
    ],
    exclude: [
      'hat box', 'hatbox', 'hat rack', 'hat stand', 'hat clip',
      'bottle cap', 'wig cap', 'lens cap', 'gift card'
    ]
  },

  beard: {
    label: 'beard / moustache',
    needs: 'face',
    keepFace: false,
    photoHint: 'Use a clear, front-facing photo with your whole face, chin and jaw in view.',
    placement: 'with this beard or moustache on their face exactly as shown, following the jawline and upper lip naturally, with a believable growth edge on the cheeks and matched skin tone and lighting',
    include: ['beard', 'beards', 'moustache', 'mustache', 'goatee', 'sideburns', 'stubble'],
    exclude: [
      'oil', 'balm', 'trimmer', 'shampoo', 'comb', 'brush', 'wash',
      'serum', 'cream', 'wax', 'kit', 'razor', 'gift card'
    ]
  },

  glasses: {
    label: 'glasses / sunglasses',
    needs: 'face',
    keepFace: false,
    photoHint: 'Use a clear, front-facing photo with both eyes and both ears in view.',
    placement: 'wearing these glasses on their face, correct scale, resting on the bridge of the nose and over the ears, with realistic lens tint and reflections as in the product photo',
    include: [
      'glasses', 'eyeglasses', 'sunglasses', 'spectacles', 'eyewear',
      'goggles', 'optical frames', 'glasses frames'
    ],
    exclude: ['case', 'cloth', 'cleaner', 'chain', 'strap', 'gift card']
  },

  earrings: {
    label: 'earrings',
    needs: 'ears',
    keepFace: true,
    focus: 'ears',
    photoHint: 'Use a clear, front-facing photo with both ears visible.',
    placement: 'Place one matching pair of earrings on the visible earlobes at the piercing positions, at a realistic scale. Preserve the exact shape, colour and details from the product photo.',
    include: [
      'earring', 'earrings', 'ear ring', 'studs', 'hoops',
      'ear cuff', 'ear cuffs', 'jhumka', 'jhumkas', 'drop earrings'
    ],
    exclude: [
      'gift card', 'backs', 'organizer', 'organiser',
      'nose stud', 'nose ring', 'nose pin', 'nosepin'
    ]
  },

  nosepin: {
    label: 'nose pin',
    needs: 'face',
    keepFace: false,
    focus: 'nose',
    photoHint: 'Use a clear, front-facing photo with your nose and both nostrils clearly visible.',
    placement: 'wearing this nose stud in the nose. It is a nose stud, not an earring: place exactly one small nose stud on one nostril at a realistic size, never on the ears.',
    include: [
      'nosepin', 'nose pin', 'nose pins', 'nose stud', 'nose studs',
      'nose piercing', 'nose ring', 'nose rings', 'nose hoop',
      'nose hook', 'nath', 'nostril'
    ],
    exclude: ['nose piercing kit', 'nose ring tool', 'nose ring holder', 'gift card']
  },

  jewelset: {
    label: 'jewellery set',
    needs: 'neck',
    keepFace: true,
    focus: 'ears+neck',
    photoHint: 'Use a clear, front-facing photo showing both ears, your neck and shoulders.',
    placement: 'wearing this jewellery set: the matching earrings on both earlobes and the necklace around the neck, reproduced exactly from the product photo.',
    include: [
      'jewelry set', 'jewellery set', 'jewelry sets', 'jewellery sets',
      'necklace set', 'bridal set', 'earrings necklace',
      'necklace earrings', 'earring necklace', 'necklace earring'
    ],
    exclude: ['gift card', 'box', 'organizer', 'organiser', 'stand']
  },

  necklace: {
    label: 'necklace',
    needs: 'neck',
    keepFace: true,
    focus: 'neck',
    photoHint: 'Use a clear, front-facing photo showing your neck and shoulders.',
    placement: 'wearing this necklace around their neck, hanging naturally on the collarbones and chest at its true size.',
    include: [
      'necklace', 'necklaces', 'pendant', 'pendants', 'choker',
      'chain', 'chains', 'locket', 'mangalsutra'
    ],
    exclude: ['gift card', 'box', 'stand', 'organizer', 'organiser', 'cleaner']
  },

  wrist: {
    label: 'watch / bracelet',
    needs: 'wrist',
    keepFace: false,
    photoHint: 'Use a photo of your wrist and hand with the whole wrist in view (a face photo will not work).',
    placement: 'wearing this watch or bracelet on the wrist, fitted snugly at its true size, with realistic shadows and reflections.',
    include: [
      'watch', 'watches', 'wristwatch', 'smartwatch', 'chronograph',
      'bracelet', 'bracelets', 'bangle', 'bangles',
      'cuff bracelet', 'wristband', 'kada'
    ],
    exclude: ['watch box', 'watch winder', 'watch stand', 'watch tool', 'gift card']
  },

  ring: {
    label: 'ring',
    needs: 'hand',
    keepFace: false,
    photoHint: 'Use a photo of your hand with the fingers spread and fully in view.',
    placement: 'wearing this ring on a finger at its true size, with realistic shadows and reflections.',
    include: [
      'ring', 'rings', 'band ring', 'engagement ring',
      'wedding band', 'signet ring', 'finger ring'
    ],
    exclude: [
      'nose ring', 'nose rings', 'ear ring', 'earring', 'earrings',
      'key ring', 'ring light', 'ring box', 'ring holder', 'gift card'
    ]
  },

  headwear: {
    label: 'headband / hair accessory',
    needs: 'face',
    keepFace: true,
    photoHint: 'Use a clear, front-facing photo with your whole head in view.',
    placement: 'wearing this headband or hair accessory in their hair at its true size.',
    include: [
      'headband', 'headbands', 'hair clip', 'hair clips', 'claw clip',
      'hair band', 'scrunchie', 'scrunchies', 'hair pin', 'hairpin',
      'barrette', 'bandana', 'hair tie', 'tiara', 'crown',
      'hair accessory', 'hair accessories'
    ],
    exclude: ['gift card']
  },

  scarf: {
    label: 'scarf / shawl',
    needs: 'neck',
    keepFace: true,
    photoHint: 'Use a clear, front-facing photo showing your neck and shoulders.',
    placement: 'wearing this scarf or shawl around the neck or draped over the shoulders, with realistic folds.',
    include: ['scarf', 'scarves', 'shawl', 'stole', 'dupatta', 'hijab'],
    exclude: ['gift card', 'pin', 'ring', 'holder']
  },

  makeup: {
    label: 'makeup shade',
    needs: 'face',
    keepFace: false,
    photoHint: 'Use a clear, front-facing photo in good light.',
    placement: 'wearing this makeup product applied exactly as intended and in the exact shade shown.',
    include: [
      'lipstick', 'lip gloss', 'lip stain', 'lip liner',
      'blush', 'eyeshadow', 'eye shadow', 'eyeliner',
      'foundation', 'bronzer', 'highlighter'
    ],
    exclude: ['brush', 'sponge', 'remover', 'bag', 'case', 'gift card']
  },

  // Automatic fallback for products without useful Shopify type/tags.
  generic: {
    label: 'this product',
    needs: 'face',
    keepFace: true,
    photoHint: 'Use a clear, front-facing photo showing your head and shoulders.',
    placement: 'wearing or using the product shown in image 2 in the natural way it is intended to be used, at a realistic size and position',
    include: [],
    exclude: [
      'gift card', 'snowboard', 'furniture', 'shampoo', 'conditioner',
      'cleanser', 'soap', 'serum', 'cream', 'lotion', 'oil',
      'box', 'case', 'stand', 'organizer', 'organiser', 'tool',
      'brush', 'comb'
    ]
  }
};

export const FOCUS_AREAS = ['nose', 'ears', 'neck', 'ears+neck'];

const norm = (x) =>
  ` ${String(x || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

const has = (hay, phrase) =>
  hay.includes(` ${norm(phrase).trim()} `);

export function categoryIds() {
  return Object.keys(CATEGORIES);
}

export function classify(product, hint) {
  if (hint && CATEGORIES[hint]) {
    return { id: hint, by: 'metafield' };
  }

  const typeText = norm([product.type, ...(product.tags || [])].join(' '));
  const nameText = norm(
    `${product.title || ''} ${String(product.handle || '').replace(/-/g, ' ')}`
  );
  const all = typeText + nameText;

  let best = null;
  let bestScore = 0;
  let bestBy = 'none';

  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (id === 'generic') continue; // only used when a store opts in (see genericAllowed)
    if (cat.exclude.some((phrase) => has(all, phrase))) continue;

    let score = 0;
    let by = 'name';

    for (const phrase of cat.include) {
      const wordCount = norm(phrase).trim().split(' ').length;

      if (has(typeText, phrase)) {
        score = Math.max(score, 3 * wordCount);
        by = 'type';
      } else if (has(nameText, phrase)) {
        score = Math.max(score, 2 * wordCount);
      }
    }

    if (score > bestScore) {
      best = id;
      bestScore = score;
      bestBy = by;
    }
  }

  return {
    id: best,
    by: best ? bestBy : 'none'
  };
}
/** The catch-all "generic" category is opt-in per store; never for things that are clearly not wearable. */
export function genericAllowed(product) {
  const all = norm([product.type, ...(product.tags || []), product.title, String(product.handle || '').replace(/-/g, ' ')].join(' '));
  return Boolean(product.images?.length) && !CATEGORIES.generic.exclude.some((phrase) => has(all, phrase));
}

/** Categories a merchant can choose from when mapping a product type or a single product. */
export function categoryChoices() {
  return Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, needs: c.needs }));
}
