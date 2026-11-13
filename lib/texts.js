// Every line of text the shopper sees in the try-on block. The merchant can change any of them in the
// Shopify admin (lookOn > Texts); anything left blank falls back to the default here.
// {category} and {product} are filled in by the block.

export const TEXT_GROUPS = [
  {
    id: 'main', label: 'Block and buttons',
    keys: {
      heading: 'lookOn',
      subheading: 'Add a front-facing photo to see this on you.',
      photoHint: '',  // blank = the hint for the product's category (e.g. "show your wrist" for watches)
      chooseButton: 'Choose photo to try on {category}',
      selfieButton: 'Take selfie',
      captureButton: 'Capture',
      cancelButton: 'Cancel',
      consent: "This is a photo of me and I'm 18 or over. I understand it is sent to an AI service to make the preview and is not saved.",
      privacy: 'Previews are AI-made and approximate: colour, size and fit will differ a little from the real product.',
    },
  },
  {
    id: 'progress', label: 'While it works',
    keys: {
      consentRequired: 'Please tick the box above first.',
      stillLoading: 'One moment, the try-on is still loading.',
      loadingPhoto: 'Loading your photo…',
      checkingPhoto: 'Checking your photo…',
      generating: 'Styling your preview… this can take up to a minute.',
      loaderLabel: 'Creating your preview…',
      scanPhoto: 'Scanning your photo…',
      scanFit: 'Finding the right fit…',
      scanPlace: 'Placing {product} on you…',
      scanFinish: 'Adding the final touches…',
      scanAlmost: 'Almost there…',
      scanSub: 'Usually 15–30 seconds',
      cameraPrompt: 'Look at the camera and press Capture.',
      cameraStarting: 'The camera is still starting. Try again in a second.',
      cameraUnavailable: 'The camera is not available. Please use Choose photo instead.',
      photoUnreadable: 'We couldn\'t open that file. Choose a JPG or PNG photo.',
    },
  },
  {
    id: 'result', label: 'Result',
    keys: {
      showOriginal: 'Show my original photo',
      showPreview: 'Show the preview',
      previewOption: 'Preview this option',
      download: 'Download',
      keepFace: 'Keep my real face exactly as in my photo',
      resultDone: 'AI preview of {product} on you.',
      resultFaceKept: 'AI preview of {product}. Your real face is kept exactly as in your photo; the rest is AI-made.',
      resultFaceMissing: 'AI preview of {product}. We could not find your face in the photo, so the face may differ slightly. A clear, front-facing photo works best.',
      resultFaceNotAligned: 'AI preview of {product}. We could not line your face up exactly, so the plain AI picture is shown.',
      resultFocus: 'AI preview of {product} on you. Only the {area} area is AI-made; the rest is your original photo.',
      resultFocusMissed: 'The AI did not place {product} clearly this time. Please try again, ideally with a sharper, front-facing photo.',
    },
  },
  {
    id: 'photo', label: 'Photo checks',
    keys: {
      photoTitle: 'Let\'s try another photo',
      tryAnyway: 'Use this photo anyway',
      noFace: 'We could not find a face in that photo. Please use a clear, front-facing photo with your whole face in view.',
      faceSmall: 'Your face looks very small in this photo. Please move closer or use a closer photo.',
      earsCut: 'Your ears are cut off in this photo. Please use a photo that shows both ears.',
      noNeck: 'We cannot see enough of your neck and shoulders. Please use a photo that shows your neck and shoulders.',
      noHand: 'We could not find a hand or wrist in that photo. This product needs a photo of your wrist and hand (a face photo will not work).',
      wristCut: 'Your wrist is cut off in this photo. Please show your whole wrist and hand.',
      fingersCut: 'Your fingers are cut off in this photo. Please show your whole hand with the fingers visible.',
    },
  },
  {
    id: 'access', label: 'Email and sign-in',
    keys: {
      freeLeft: '{count} free try-ons left',
      gateTitle: 'Keep trying on',
      gateEmailIntro: 'Enter your email to keep trying on. It\'s free.',
      gateLoginIntro: 'Sign in to your account to keep trying on.',
      gateEitherIntro: 'Enter your email or sign in to keep trying on.',
      gateEmailPlaceholder: 'you@example.com',
      gateEmailButton: 'Continue',
      gateLoginButton: 'Sign in',
      gateOr: 'or',
      gateMarketing: 'Email me offers and news from this store',
      gateEmailInvalid: 'Enter a valid email address.',
      gateThanks: 'Thanks! You can keep trying on.',
      limitProduct: 'You\'ve reached the try-on limit for this product.',
      limitDay: 'You\'ve reached today\'s try-on limit. Please come back tomorrow.',
      productLeft: '{count} try-ons left for this product',
    },
  },
  {
    id: 'errors', label: 'Errors and limits',
    keys: {
      errorTitle: 'We couldn\'t finish your preview',
      offlineTitle: 'You\'re offline',
      busyTitle: 'Lots of try-ons right now',
      pausedTitle: 'Try-on is taking a break',
      outOfCredits: 'Try-on is paused on this store for now. Please check back soon.',
      genericError: 'Something interrupted your preview. Please try again.',
      unavailable: 'Try-on isn\'t available right now. Please check back a little later.',
      networkError: 'Check your internet connection, then try again.',
      timeout: 'This took longer than expected. Please try again.',
      busy: 'Please try again in a minute.',
      photoTooLarge: 'This photo is too large. Choose one under 25 MB.',
      retryButton: 'Try again',
      newPhotoButton: 'Use another photo',
    },
  },
];

export const DEFAULT_TEXTS = Object.freeze(Object.assign({}, ...TEXT_GROUPS.map((g) => g.keys)));
const MAX_LEN = 400;

// The earlier 7-field "Try-On text" settings (/app/api/settings) map onto these keys.
export const LEGACY_KEYS = Object.freeze({ heading: 'heading', subheading: 'subheading', photoHint: 'photoHint', buttonLabel: 'chooseButton', selfieLabel: 'selfieButton', consentText: 'consent', privacyText: 'privacy' });
export const LEGACY_DEFAULTS = Object.freeze({
  // Keep the previous legacy default recognized as unchanged so existing records do not
  // preserve the old label when the new global default is applied.
  heading: 'Try it on', subheading: 'Add a front-facing photo to see this on you.', photoHint: 'Use a clear, front-facing photo with your whole head and shoulders in view.',
  buttonLabel: 'Choose photo', selfieLabel: 'Take selfie', consentText: DEFAULT_TEXTS.consent, privacyText: DEFAULT_TEXTS.privacy,
});

/** Only the lines the merchant changed in the app (including ones saved through the older settings form). */
export function customTexts(record) {
  const out = {};
  const legacy = record?.tryOnSettings || {};
  for (const [old, key] of Object.entries(LEGACY_KEYS)) if (typeof legacy[old] === 'string' && legacy[old].trim() && legacy[old].trim() !== LEGACY_DEFAULTS[old]) out[key] = legacy[old].trim();
  for (const [k, v] of Object.entries(record?.widget?.texts || {})) if (k in DEFAULT_TEXTS && typeof v === 'string' && v.trim()) out[k] = v;
  return out;
}

/** Merchant overrides merged over the defaults. */
export function textsFor(record) {
  return { ...DEFAULT_TEXTS, ...customTexts(record) };
}

/** Keep only known keys; blank means "use the default". Throws on over-long text. */
export function cleanTexts(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in DEFAULT_TEXTS) || typeof v !== 'string') continue;
    const t = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
    if (t.length > MAX_LEN) { const e = new Error(`"${k}" is longer than ${MAX_LEN} characters.`); e.status = 400; throw e; }
    if (t && t !== DEFAULT_TEXTS[k]) out[k] = t;
  }
  return out;
}
